import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { CreateWorktreeArgs, ProjectRef } from '@/lib/worktrees/worktreeManager';
import type { Config } from '@/lib/opencode/model';
import type { ProjectEntry } from '@/lib/api/types';
import type { WorktreeMetadata } from '@/types/worktree';

const project: ProjectRef = { id: 'project-1', path: '/repo' };

type DraftState = {
  draftId: number;
  open: boolean;
  target: 'chat' | 'project';
  selectedProjectId?: string | null;
  directoryOverride: string | null;
  pendingWorktreeRequestId?: string | null;
  bootstrapPendingDirectory?: string | null;
  preserveDirectoryOverride?: boolean;
  parentID: string | null;
  title?: string;
  initialPrompt?: string;
};

const emptyDraft = (): DraftState => ({
  draftId: 1,
  open: false,
  target: 'project',
  selectedProjectId: null,
  directoryOverride: null,
  pendingWorktreeRequestId: null,
  bootstrapPendingDirectory: null,
  preserveDirectoryOverride: false,
  parentID: null,
});

let draftState = emptyDraft();
let activeProject: { id: string; path: string } | null = { id: project.id, path: project.path };
let resolvedCommands: string[] | null = null;
const createdPayloads: CreateWorktreeArgs[] = [];
const rejectedRequests: Array<{ id: string; message: string }> = [];
const resolvedRequests: Array<{ id: string; directory: string }> = [];
const directories: string[] = [];
const toastErrors: string[] = [];

type FakeAgent = { name: string };

const sessionStoreState = {
  availableWorktreesByProject: new Map(),
  createSession: async (_title?: string, _directory?: string) => ({ id: 'session-1' }),
  initializeNewOpenChamberSession: (_sessionId: string, _agents: FakeAgent[]) => undefined,
  setSessionDirectory: (_sessionId: string, _directory: string | null) => undefined,
  setWorktreeMetadata: (_sessionId: string, _metadata: WorktreeMetadata | null, _cwd?: string) => undefined,
  get newSessionDraft() {
    return draftState;
  },
  overrideNewSessionDraftTarget: (patch: Partial<DraftState>) => {
    draftState = { ...draftState, ...patch };
  },
  openNewSessionDraft: (options: Partial<DraftState>) => {
    draftState = { ...emptyDraft(), ...options, open: true, target: 'project' };
  },
  closeNewSessionDraft: () => {
    draftState = emptyDraft();
  },
  resolvePendingDraftWorktreeTarget: (requestId: string, directory: string | null) => {
    if (draftState.pendingWorktreeRequestId !== requestId) return;
    draftState = { ...draftState, pendingWorktreeRequestId: null, directoryOverride: directory };
  },
  setDraftBootstrapPendingDirectory: (directory: string | null) => {
    draftState = { ...draftState, bootstrapPendingDirectory: directory };
  },
};

mock.module('@/components/ui', () => ({
  toast: {
    error: (title: string) => {
      toastErrors.push(title);
    },
    success: mock(),
  },
}));

mock.module('@/lib/gitApi', () => ({
  checkIsGitRepository: async () => true,
  resolveGitPrimaryRoot: async () => project.path,
  resolveGitRepositoryPrefix: async () => '',
  validateWorktreeDirectory: async () => ({ valid: true, insideWorktreeRoot: true }),
}));

mock.module('@/lib/git/branchNameGenerator', () => ({
  generateBranchName: () => 'generated-branch',
}));

mock.module('@/lib/modelIdentifier', () => ({
  parseModelIdentifier: () => null,
  parseModelSelection: () => null,
  formatModelSelection: () => null,
}));

mock.module('@/lib/openchamberConfig', () => ({
  getWorktreeSetupWaitEnabled: async () => false,
}));

mock.module('@/lib/sharedTrustConfirmation', () => ({
  resolveWorktreeSetupCommands: async () => resolvedCommands ?? [],
  resolveWorktreeSetupCommandsOrCancel: async () => resolvedCommands,
}));

mock.module('@/lib/pathNormalization', () => ({
  normalizePath: (value: string | null) => value,
}));

mock.module('@/lib/projectResolution', () => ({
  resolveProjectForDirectory: (_projects: ProjectEntry[], directory: string | null) =>
    directory === project.path ? { id: project.id, path: project.path } : null,
}));

mock.module('@/lib/worktrees/worktreeBootstrap', () => ({
  waitForWorktreeBootstrap: mock(async () => undefined),
  waitForWorktreeGitReady: async () => undefined,
}));

mock.module('@/lib/worktrees/worktreeStatus', () => ({
  getRootBranch: async () => 'main',
}));

mock.module('@/lib/worktrees/worktreeManager', () => ({
  removeProjectWorktree: mock(async () => undefined),
}));

mock.module('@/lib/worktrees/worktreeCreate', () => ({
  createWorktreeWithDefaults: async (_project: ProjectRef, args: CreateWorktreeArgs) => {
    createdPayloads.push(args);
    return {
      source: 'sdk',
      name: 'generated-branch',
      path: '/repo/.oc/worktrees/generated-branch',
      projectDirectory: project.path,
      branch: 'generated-branch',
      label: 'generated-branch',
    };
  },
}));

mock.module('@/lib/worktrees/pendingDraftWorktree', () => ({
  createPendingDraftWorktreeRequest: () => 'request-1',
  rejectPendingDraftWorktreeRequest: (id: string, error: Error) => {
    rejectedRequests.push({ id, message: error.message });
  },
  resolvePendingDraftWorktreeRequest: (id: string, directory: string) => {
    resolvedRequests.push({ id, directory });
  },
  waitForPendingDraftWorktreeRequest: async () => '/repo/.oc/worktrees/generated-branch',
}));

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: { getState: () => sessionStoreState },
}));

mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      projects: [{ id: project.id, path: project.path }],
      getActiveProject: () => activeProject,
    }),
  },
}));

type FakeConfigState = {
  agents: FakeAgent[];
  currentAgentName?: string;
  currentProviderId?: string;
  currentModelId?: string;
  currentVariant?: string;
};

const configStoreState: FakeConfigState = { agents: [] };

type ConfigDefaultsCall = {
  directory: string | null | undefined;
  source: string | undefined;
  config: Config | undefined;
};

type ConfigStoreCalls = {
  activateDirectory: string[];
  applyOpenCodeConfigDefaults: ConfigDefaultsCall[];
  applyDefaultModelAgentSelection: number;
};

const configStoreCalls: ConfigStoreCalls = { activateDirectory: [], applyOpenCodeConfigDefaults: [], applyDefaultModelAgentSelection: 0 };

mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({
      ...configStoreState,
      activateDirectory: async (directory: string | null | undefined) => {
        configStoreCalls.activateDirectory.push(directory ?? '');
      },
      applyOpenCodeConfigDefaults: (
        directory: string | null | undefined,
        source: string | undefined,
        config: Config | undefined,
      ) => {
        configStoreCalls.applyOpenCodeConfigDefaults.push({ directory, source, config });
      },
      applyDefaultModelAgentSelection: () => {
        configStoreCalls.applyDefaultModelAgentSelection += 1;
      },
    }),
  },
}));

type AgentSelectionSave = { sessionId: string; agentName: string };
type ModelSelectionSave = { sessionId: string; providerId: string; modelId: string };
type AgentModelSave = ModelSelectionSave & { agentName: string };
type AgentModelVariantSave = AgentModelSave & { variant: string | null | undefined };

type ContextStoreSaves = {
  saveSessionAgentSelection: AgentSelectionSave[];
  saveSessionModelSelection: ModelSelectionSave[];
  saveAgentModelForSession: AgentModelSave[];
  saveAgentModelVariantForSession: AgentModelVariantSave[];
};

const contextStoreSaves: ContextStoreSaves = {
  saveSessionAgentSelection: [],
  saveSessionModelSelection: [],
  saveAgentModelForSession: [],
  saveAgentModelVariantForSession: [],
};

mock.module('@/stores/contextStore', () => ({
  useContextStore: {
    getState: () => ({
      saveSessionAgentSelection: (sessionId: string, agentName: string) => {
        contextStoreSaves.saveSessionAgentSelection.push({ sessionId, agentName });
      },
      saveSessionModelSelection: (sessionId: string, providerId: string, modelId: string) => {
        contextStoreSaves.saveSessionModelSelection.push({ sessionId, providerId, modelId });
      },
      saveAgentModelForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => {
        contextStoreSaves.saveAgentModelForSession.push({ sessionId, agentName, providerId, modelId });
      },
      saveAgentModelVariantForSession: (
        sessionId: string,
        agentName: string,
        providerId: string,
        modelId: string,
        variant: string | null | undefined,
      ) => {
        contextStoreSaves.saveAgentModelVariantForSession.push({ sessionId, agentName, providerId, modelId, variant });
      },
    }),
  },
}));

let folderConfigResponse: Config | null = null;

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getConfig: async () => folderConfigResponse,
  },
}));

mock.module('@/stores/useDirectoryStore', () => ({
  useDirectoryStore: {
    getState: () => ({
      setDirectory: (directory: string) => {
        directories.push(directory);
      },
    }),
  },
}));

const { createQuickWorktree, createWorktreeDraft, createWorktreeSessionForNewBranch } = await import('./worktreeSessionCreator');

describe('quick worktree trust', () => {
  beforeEach(() => {
    draftState = emptyDraft();
    activeProject = { id: project.id, path: project.path };
    resolvedCommands = null;
    createdPayloads.length = 0;
    rejectedRequests.length = 0;
    resolvedRequests.length = 0;
    directories.length = 0;
    toastErrors.length = 0;
  });

  test('a cancelled trust prompt creates no worktree', async () => {
    expect(await createQuickWorktree(project, { cancelOnTrustDismiss: true })).toBeNull();
    expect(createdPayloads).toHaveLength(0);
  });

  test('a cancelled prompt rolls the draft back instead of leaving Creating... up', async () => {
    draftState = {
      ...emptyDraft(),
      open: true,
      selectedProjectId: project.id,
      directoryOverride: '/repo/.oc/worktrees/existing',
      preserveDirectoryOverride: true,
    };

    expect(await createWorktreeDraft()).toBeNull();

    expect(createdPayloads).toHaveLength(0);
    expect(rejectedRequests.map((request) => request.id)).toEqual(['request-1']);
    expect(draftState.open).toBe(true);
    expect(draftState.pendingWorktreeRequestId).toBeNull();
    expect(draftState.directoryOverride).toBe('/repo/.oc/worktrees/existing');
    expect(draftState.bootstrapPendingDirectory).toBeNull();
    expect(toastErrors).toEqual([]);
  });

  test('a cancelled prompt closes the draft it opened for the worktree', async () => {
    expect(await createWorktreeDraft()).toBeNull();

    expect(draftState.open).toBe(false);
    expect(draftState.pendingWorktreeRequestId).toBeNull();
  });

  test('skipping the shared commands still creates the worktree with the personal ones', async () => {
    resolvedCommands = ['cp .env.example .env'];

    expect(await createWorktreeDraft()).toBe('/repo/.oc/worktrees/generated-branch');

    expect(createdPayloads).toHaveLength(1);
    expect(createdPayloads[0]?.setupCommands).toEqual(['cp .env.example .env']);
    expect(resolvedRequests).toEqual([{ id: 'request-1', directory: '/repo/.oc/worktrees/generated-branch' }]);
    expect(directories).toContain('/repo/.oc/worktrees/generated-branch');
    expect(draftState.pendingWorktreeRequestId).toBeNull();
    expect(toastErrors).toEqual([]);
  });

  test('trusting the shared commands creates the worktree with the full list', async () => {
    resolvedCommands = ['bun install', 'cp .env.example .env'];

    expect(await createWorktreeDraft()).toBe('/repo/.oc/worktrees/generated-branch');

    expect(createdPayloads).toHaveLength(1);
    expect(createdPayloads[0]?.setupCommands).toEqual(['bun install', 'cp .env.example .env']);
  });
});

describe('new-branch worktree session defaults', () => {
  const worktreePath = '/repo/.oc/worktrees/generated-branch';

  beforeEach(() => {
    configStoreState.agents = [];
    configStoreState.currentAgentName = undefined;
    configStoreState.currentProviderId = undefined;
    configStoreState.currentModelId = undefined;
    configStoreState.currentVariant = undefined;
    configStoreCalls.activateDirectory = [];
    configStoreCalls.applyOpenCodeConfigDefaults = [];
    configStoreCalls.applyDefaultModelAgentSelection = 0;
    contextStoreSaves.saveSessionAgentSelection = [];
    contextStoreSaves.saveSessionModelSelection = [];
    contextStoreSaves.saveAgentModelForSession = [];
    contextStoreSaves.saveAgentModelVariantForSession = [];
    folderConfigResponse = null;
  });

  test('activates the folder config before saving the session selection', async () => {
    folderConfigResponse = { default_agent: 'plan', model: 'anthropic/claude-sonnet-4-6' };
    configStoreState.agents = [{ name: 'plan' }, { name: 'build' }];
    configStoreState.currentAgentName = 'plan';
    configStoreState.currentProviderId = 'anthropic';
    configStoreState.currentModelId = 'claude-sonnet-4-6';
    configStoreState.currentVariant = 'high';

    const result = await createWorktreeSessionForNewBranch(project.path, 'feature-x');

    expect(result).toEqual({ id: 'session-1', branch: 'generated-branch', path: worktreePath, directory: worktreePath });
    expect(configStoreCalls.activateDirectory).toEqual([worktreePath]);
    expect(configStoreCalls.applyOpenCodeConfigDefaults).toEqual([
      { directory: worktreePath, source: 'manual', config: folderConfigResponse },
    ]);
    expect(configStoreCalls.applyDefaultModelAgentSelection).toBe(1);
    expect(contextStoreSaves.saveSessionAgentSelection).toEqual([{ sessionId: 'session-1', agentName: 'plan' }]);
    expect(contextStoreSaves.saveSessionModelSelection).toEqual([
      { sessionId: 'session-1', providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
    ]);
    expect(contextStoreSaves.saveAgentModelForSession).toEqual([
      { sessionId: 'session-1', agentName: 'plan', providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
    ]);
    expect(contextStoreSaves.saveAgentModelVariantForSession).toEqual([
      { sessionId: 'session-1', agentName: 'plan', providerId: 'anthropic', modelId: 'claude-sonnet-4-6', variant: 'high' },
    ]);
  });

  test('keeps the folder default_agent when the cold catalog cannot validate it', async () => {
    folderConfigResponse = { default_agent: 'plan' };
    // A cold directory's first agent read answers empty, so the cascade
    // resolves no agent even though the folder config names one.
    configStoreState.agents = [];
    configStoreState.currentAgentName = undefined;
    configStoreState.currentProviderId = 'anthropic';
    configStoreState.currentModelId = 'claude-sonnet-4-6';

    const result = await createWorktreeSessionForNewBranch(project.path, 'feature-x');

    expect(result?.id).toBe('session-1');
    expect(contextStoreSaves.saveSessionAgentSelection).toEqual([{ sessionId: 'session-1', agentName: 'plan' }]);
    expect(contextStoreSaves.saveSessionModelSelection).toEqual([
      { sessionId: 'session-1', providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
    ]);
  });

  test('falls back to the resolved selection when the folder config cannot be fetched', async () => {
    folderConfigResponse = null;
    configStoreState.agents = [{ name: 'build' }];
    configStoreState.currentAgentName = 'build';
    configStoreState.currentProviderId = 'anthropic';
    configStoreState.currentModelId = 'claude-sonnet-4-6';

    const result = await createWorktreeSessionForNewBranch(project.path, 'feature-x');

    expect(result?.id).toBe('session-1');
    expect(configStoreCalls.applyOpenCodeConfigDefaults).toEqual([]);
    expect(contextStoreSaves.saveSessionAgentSelection).toEqual([{ sessionId: 'session-1', agentName: 'build' }]);
  });
});
