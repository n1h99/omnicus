import {
  addEdge,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { validateScenarioGraph } from '@omnicus/automation-core';
import {
  ApiOutlined,
  BranchesOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CopyOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  ExclamationCircleOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  RedoOutlined,
  SearchOutlined,
  SendOutlined,
  SettingOutlined,
  StopOutlined,
  SyncOutlined,
  TagsOutlined,
  ThunderboltOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import {
  Button,
  Card,
  Checkbox,
  Col,
  Collapse,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Result,
  Row,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Timeline,
  Typography,
  message,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { AutomationConditionGroupFields, AutomationNodeConfig } from '../automation-node-config';
import { AutomationGraphPreview } from '../automation-graph-preview';
import {
  automationEdgeLabel,
  type AutomationEdgeData,
  flowToScenarioGraph,
  scenarioGraphToFlow,
  spreadCompactFlowNodes,
} from '../automation-editor-graph';
import {
  emptyScenarioGraph,
  type AutomationSimulationResult,
  type Scenario,
  type ScenarioExecution,
  useScenario,
  useScenarioExecutions,
  useScenarioMutations,
  useScenarios,
} from '../automation-api';
import { AutomationTestPanel, type AutomationTestInput } from '../automation-test-panel';
import { ApiError, getUserErrorMessage } from '../api';
import {
  automationActionErrorMessage,
  automationEditorSignature,
  automationNodeDescription,
  automationNodeLabel,
  humanizeAutomationValidationIssue,
  normalizeScenarioDescription,
  safeDiagnosticJson,
  validateAutomationResources,
} from '../automation-studio';
import {
  useAutomationHttpMutations,
  useAutomationSecrets,
  useAutomationCustomFields,
  useAutomationTags,
  type AutomationCustomField,
} from '../automation-studio-api';
import { hasProjectPermission, useProjectAccess } from '../project-access';
import { StatusText } from '../status-text';
import { useTemplates } from '../templates-api';
import { useEmailTemplates } from '../email-api';

const paletteGroups = [
  {
    key: 'integrations',
    label: 'Integrations',
    nodes: [['EXTERNAL_HTTP_REQUEST', 'External HTTP request']],
  },
  {
    key: 'triggers',
    label: 'Triggers',
    nodes: [['INCOMING_MESSAGE', 'Incoming message']],
  },
  {
    key: 'logic',
    label: 'Logic',
    nodes: [
      ['CONDITION', 'Condition'],
      ['DELAY', 'Delay'],
      ['WAIT_FOR_REPLY', 'Wait for reply'],
      ['START_SUBFLOW', 'Subflow'],
      ['STOP', 'Stop'],
    ],
  },
  {
    key: 'messaging',
    label: 'Messaging',
    nodes: [
      ['SEND_MESSAGE', 'Send message'],
      ['SEND_TEMPLATE', 'Send template'],
      ['SEND_EMAIL', 'Send email'],
      ['FORWARD_TO_CRM', 'Forward to CRM'],
    ],
  },
  {
    key: 'data',
    label: 'Data & control',
    nodes: [
      ['CREATE_OR_UPDATE_LEAD', 'Create/update lead'],
      ['ADD_TAG', 'Add tag'],
      ['REMOVE_TAG', 'Remove tag'],
      ['SET_CUSTOM_FIELD', 'Set custom field'],
      ['CLEAR_CUSTOM_FIELD', 'Clear custom field'],
      ['PAUSE_AUTOMATION', 'Pause automation'],
      ['RESUME_AUTOMATION', 'Resume automation'],
    ],
  },
] as const;

const paletteLabels = new Map<string, string>(
  paletteGroups.flatMap((group) =>
    group.nodes.map(([type, label]) => [type, label] as [string, string]),
  ),
);

type AutomationCanvasNodeDefinition = Node<{ label: string }, 'automation'>;

function automationNodeIcon(rawType: string) {
  const type = rawType.split('\u0000')[0] ?? rawType;
  if (type === 'INCOMING_MESSAGE') return <ThunderboltOutlined />;
  if (type === 'CONDITION') return <BranchesOutlined />;
  if (type === 'SEND_MESSAGE' || type === 'SEND_TEMPLATE' || type === 'SEND_EMAIL')
    return <SendOutlined />;
  if (type === 'FORWARD_TO_CRM' || type === 'EXTERNAL_HTTP_REQUEST') return <ApiOutlined />;
  if (
    type === 'CREATE_OR_UPDATE_LEAD' ||
    type === 'SET_CUSTOM_FIELD' ||
    type === 'CLEAR_CUSTOM_FIELD'
  )
    return <DatabaseOutlined />;
  if (type === 'ADD_TAG' || type === 'REMOVE_TAG') return <TagsOutlined />;
  if (type === 'DELAY' || type === 'WAIT_FOR_REPLY') return <ClockCircleOutlined />;
  if (type === 'PAUSE_AUTOMATION') return <PauseCircleOutlined />;
  if (type === 'RESUME_AUTOMATION') return <PlayCircleOutlined />;
  if (type === 'STOP') return <StopOutlined />;
  if (type === 'START_SUBFLOW') return <BranchesOutlined />;
  return <SettingOutlined />;
}

function automationNodeCategory(type: string) {
  if (type === 'INCOMING_MESSAGE') return 'Trigger';
  if (['CONDITION', 'DELAY', 'WAIT_FOR_REPLY', 'START_SUBFLOW'].includes(type)) return 'Logic';
  if (type === 'STOP') return 'End';
  return 'Action';
}

function AutomationCanvasNode({ data, selected }: NodeProps<AutomationCanvasNodeDefinition>) {
  const type = String(data.label);
  return (
    <div
      className={`automation-flow-node automation-flow-node--${automationNodeCategory(type).toLowerCase()}${selected ? ' is-selected' : ''}`}
    >
      <Handle className="automation-node-handle" position={Position.Top} type="target" />
      <span className="automation-flow-node-icon">{automationNodeIcon(type)}</span>
      <span className="automation-flow-node-copy">
        <small>{automationNodeCategory(type)}</small>
        <strong>{paletteLabels.get(type) ?? type}</strong>
      </span>
      <Handle className="automation-node-handle" position={Position.Bottom} type="source" />
    </div>
  );
}

const automationNodeTypes: NodeTypes = { automation: AutomationCanvasNode };
const automationEdgeDefaults: Partial<Edge> = {
  labelBgBorderRadius: 8,
  labelBgPadding: [7, 4],
  labelBgStyle: { fill: '#ffffff', fillOpacity: 0.96 },
  labelStyle: { fill: '#475569', fontSize: 10, fontWeight: 600 },
  style: { stroke: '#94a3b8', strokeWidth: 2 },
  type: 'smoothstep',
};

async function fitDefaultAutomationViewport(instance: ReactFlowInstance) {
  await instance.fitView({ padding: 0.24 });
  await instance.zoomOut({ duration: 0 });
  await instance.zoomOut({ duration: 0 });
}

function styledNodes(nodes: Node[]): Node[] {
  return spreadCompactFlowNodes(nodes).map((node) => ({ ...node, type: 'automation' }));
}

interface AutomationEditorSnapshot {
  configs: Record<string, Record<string, unknown>>;
  edges: Edge[];
  nodes: Node[];
}

function cloneEditorSnapshot(snapshot: AutomationEditorSnapshot): AutomationEditorSnapshot {
  return structuredClone(snapshot);
}

export function ScenarioEditorPage() {
  const { projectId, scenarioId } = useParams();
  const navigate = useNavigate();
  const access = useProjectAccess(projectId);
  const scenarioQuery = useScenario(projectId, scenarioId === 'new' ? undefined : scenarioId);
  const scenarios = useScenarios(projectId);
  const templates = useTemplates(projectId);
  const emailTemplates = useEmailTemplates(projectId);
  const tags = useAutomationTags(projectId);
  const customFields = useAutomationCustomFields(projectId);
  const automationSecrets = useAutomationSecrets(projectId);
  const automationHttp = useAutomationHttpMutations(projectId);
  const executions = useScenarioExecutions(projectId, scenarioId);
  const mutations = useScenarioMutations(projectId);
  const [form] = Form.useForm<{ description?: string; name: string }>();
  const initial = useMemo(() => {
    const flow = scenarioGraphToFlow(emptyScenarioGraph);
    return { ...flow, nodes: styledNodes(flow.nodes) };
  }, []);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [configs, setConfigs] = useState<Record<string, Record<string, unknown>>>({});
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const [inspectedExecution, setInspectedExecution] = useState<ScenarioExecution>();
  const [testOpen, setTestOpen] = useState(false);
  const [testResult, setTestResult] = useState<AutomationSimulationResult>();
  const [previewVersion, setPreviewVersion] = useState<Scenario['versions'][number]>();
  const [paletteSearch, setPaletteSearch] = useState('');
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance>();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isCanvasInteractive, setIsCanvasInteractive] = useState(true);
  const [historyPast, setHistoryPast] = useState<AutomationEditorSnapshot[]>([]);
  const [historyFuture, setHistoryFuture] = useState<AutomationEditorSnapshot[]>([]);
  const copiedNode = useRef<AutomationEditorSnapshot['nodes'][number] | undefined>(undefined);
  const copiedConfig = useRef<Record<string, unknown> | undefined>(undefined);
  const skipBeforeUnloadRef = useRef(false);
  const [unsavedLeaveUrl, setUnsavedLeaveUrl] = useState<string>();
  const [unsavedLeaveModalOpen, setUnsavedLeaveModalOpen] = useState(false);
  const [lastSavedSignature, setLastSavedSignature] = useState<string>();
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState<string>();
  const [manualSavePending, setManualSavePending] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'conflict' | 'dirty' | 'saved'>('saved');
  const scenarioName = Form.useWatch('name', form);
  const scenarioDescription = Form.useWatch('description', form);
  const graph = flowToScenarioGraph(nodes, edges, configs);
  const validation = validateScenarioGraph(graph);
  const validationErrors = [
    ...validation.errors.map((issue) => humanizeAutomationValidationIssue(issue, graph.nodes)),
    ...validateAutomationResources(graph, {
      ...(scenarioId ? { currentScenarioId: scenarioId } : {}),
      ...(customFields.data ? { customFields: customFields.data } : {}),
      ...(scenarios.data ? { scenarios: scenarios.data } : {}),
      ...(automationSecrets.data ? { secrets: automationSecrets.data } : {}),
      ...(tags.data ? { tags: tags.data } : {}),
      ...(templates.data ? { templates: templates.data } : {}),
      ...(emailTemplates.data ? { emailTemplates: emailTemplates.data } : {}),
    }),
  ];
  const validationWarnings = validation.warnings.map((issue) =>
    humanizeAutomationValidationIssue(issue, graph.nodes),
  );
  const signature = automationEditorSignature(graph, scenarioName, scenarioDescription);
  const newScenarioInitialSignature = useMemo(
    () => automationEditorSignature(emptyScenarioGraph, '', undefined),
    [],
  );
  const draftDirty = scenarioQuery.data
    ? lastSavedSignature !== undefined && signature !== lastSavedSignature
    : signature !== newScenarioInitialSignature;
  const hasBlockingValidation = validationErrors.length > 0;
  const filteredPaletteGroups = useMemo(() => {
    const query = paletteSearch.trim().toLowerCase();
    return paletteGroups
      .map((group) => ({
        ...group,
        nodes: group.nodes.filter(([, label]) => label.toLowerCase().includes(query)),
      }))
      .filter((group) => group.nodes.length > 0);
  }, [paletteSearch]);
  const nodeLabels = useMemo(() => {
    const totals = new Map<string, number>();
    const seen = new Map<string, number>();
    for (const node of nodes) {
      const type = String(node.data.label);
      totals.set(type, (totals.get(type) ?? 0) + 1);
    }
    return Object.fromEntries(
      nodes.map((node) => {
        const type = String(node.data.label);
        const occurrence = (seen.get(type) ?? 0) + 1;
        seen.set(type, occurrence);
        const label = automationNodeLabel(type);
        return [node.id, (totals.get(type) ?? 0) > 1 ? `${label} ${occurrence}` : label];
      }),
    );
  }, [nodes]);

  useEffect(() => {
    const scenario = scenarioQuery.data;
    const graph = scenario?.draftVersion?.graph ?? scenario?.activeVersion?.graph;
    if (!graph || !scenario) return;
    const flow = scenarioGraphToFlow(graph);
    const hydratedNodes = styledNodes(flow.nodes);
    const hydratedConfigs = Object.fromEntries(
      graph.nodes.map((node) => [node.id, node.config ?? {}]),
    );
    const hydratedGraph = flowToScenarioGraph(hydratedNodes, flow.edges, hydratedConfigs);
    setNodes(hydratedNodes);
    setEdges(flow.edges);
    setConfigs(hydratedConfigs);
    form.setFieldsValue({
      description: scenario.description ?? '',
      name: scenario.name,
    });
    setExpectedUpdatedAt(scenario.updatedAt);
    setLastSavedSignature(
      automationEditorSignature(hydratedGraph, scenario.name, scenario.description ?? undefined),
    );
    setSaveStatus('saved');
    setHistoryPast([]);
    setHistoryFuture([]);
  }, [form, scenarioQuery.data, setEdges, setNodes]);

  useEffect(() => {
    if (!isFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsFullscreen(false);
    };
    window.addEventListener('keydown', exitOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', exitOnEscape);
    };
  }, [isFullscreen]);

  useEffect(() => {
    if (!flowInstance) return;
    const frame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        void fitDefaultAutomationViewport(flowInstance);
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [flowInstance, isFullscreen]);

  const currentSnapshot = useCallback(
    (): AutomationEditorSnapshot =>
      cloneEditorSnapshot({ configs, edges: edges as Edge[], nodes: nodes as Node[] }),
    [configs, edges, nodes],
  );
  const restoreSnapshot = useCallback(
    (snapshot: AutomationEditorSnapshot) => {
      const restored = cloneEditorSnapshot(snapshot);
      setNodes(restored.nodes);
      setEdges(restored.edges);
      setConfigs(restored.configs);
      setSelectedId(undefined);
      setSelectedEdgeId(undefined);
    },
    [setEdges, setNodes],
  );
  const captureHistory = useCallback(() => {
    const snapshot = currentSnapshot();
    setHistoryPast((current) => [...current.slice(-49), snapshot]);
    setHistoryFuture([]);
  }, [currentSnapshot]);
  const undo = useCallback(() => {
    const previous = historyPast.at(-1);
    if (!previous) return;
    setHistoryFuture((current) => [currentSnapshot(), ...current.slice(0, 49)]);
    setHistoryPast((current) => current.slice(0, -1));
    restoreSnapshot(previous);
  }, [currentSnapshot, historyPast, restoreSnapshot]);
  const redo = useCallback(() => {
    const next = historyFuture[0];
    if (!next) return;
    setHistoryPast((current) => [...current.slice(-49), currentSnapshot()]);
    setHistoryFuture((current) => current.slice(1));
    restoreSnapshot(next);
  }, [currentSnapshot, historyFuture, restoreSnapshot]);
  const copySelectedNode = useCallback(() => {
    const selectedNode = nodes.find((node) => node.id === selectedId);
    if (!selectedNode) return;
    copiedNode.current = structuredClone(selectedNode);
    copiedConfig.current = structuredClone(configs[selectedNode.id] ?? {});
  }, [configs, nodes, selectedId]);
  const pasteCopiedNode = useCallback(() => {
    if (!copiedNode.current) return;
    captureHistory();
    const id = `${String(copiedNode.current.data.label).toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`;
    const pasted = {
      ...structuredClone(copiedNode.current),
      id,
      position: {
        x: copiedNode.current.position.x + 40,
        y: copiedNode.current.position.y + 40,
      },
      selected: false,
    };
    setNodes((current) => [...current, pasted]);
    setConfigs((current) => ({ ...current, [id]: structuredClone(copiedConfig.current ?? {}) }));
    setSelectedId(id);
  }, [captureHistory, setNodes]);
  const duplicateSelectedNode = useCallback(() => {
    copySelectedNode();
    pasteCopiedNode();
  }, [copySelectedNode, pasteCopiedNode]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      if (!isCanvasInteractive) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
      } else if (event.key.toLowerCase() === 'c') {
        copySelectedNode();
      } else if (event.key.toLowerCase() === 'v') {
        event.preventDefault();
        pasteCopiedNode();
      }
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [copySelectedNode, isCanvasInteractive, pasteCopiedNode, redo, undo]);

  useEffect(() => {
    if (!draftDirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (skipBeforeUnloadRef.current) return;
      event.preventDefault();
    };
    const guardLink = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement | null)?.closest('a[href]');
      if (!anchor || skipBeforeUnloadRef.current) return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      const target = anchor.getAttribute('target');
      if (target && target !== '_self') return;
      let targetUrl: URL;
      try {
        targetUrl = new URL(href, window.location.href);
      } catch {
        return;
      }
      if (
        targetUrl.origin !== window.location.origin ||
        (targetUrl.pathname === window.location.pathname &&
          targetUrl.search === window.location.search)
      ) {
        return;
      }
      event.preventDefault();
      setUnsavedLeaveUrl(targetUrl.toString());
      setUnsavedLeaveModalOpen(true);
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', guardLink, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', guardLink, true);
    };
  }, [draftDirty]);

  useEffect(() => {
    setSaveStatus((current) => (current === 'conflict' ? current : draftDirty ? 'dirty' : 'saved'));
  }, [draftDirty]);

  useEffect(() => {
    if (!inspectedExecution) return;
    const refreshed = executions.data?.find((execution) => execution.id === inspectedExecution.id);
    if (refreshed && refreshed !== inspectedExecution) setInspectedExecution(refreshed);
  }, [executions.data, inspectedExecution]);

  if (scenarioId !== 'new' && scenarioQuery.isLoading)
    return <Spin className="route-loading" size="large" />;
  if (!hasProjectPermission(access.data, 'automation:manage'))
    return (
      <Result
        status="403"
        title="Access denied"
        subTitle="Automation editing permission is required."
      />
    );

  const selected = nodes.find((node) => node.id === selectedId);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);

  const addNode = (type: string) => {
    captureHistory();
    const id = `${type.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`;
    setNodes((current) => [
      ...current,
      {
        data: { label: type },
        id,
        position: {
          x: 140,
          y: current.reduce((maximum, node) => Math.max(maximum, node.position.y), 0) + 140,
        },
        type: 'automation',
      },
    ]);
    setConfigs((current) => ({
      ...current,
      [id]:
        type === 'DELAY'
          ? { delaySeconds: 60 }
          : type === 'WAIT_FOR_REPLY'
            ? { timeoutSeconds: 300 }
            : type === 'EXTERNAL_HTTP_REQUEST'
              ? {
                  contentType: 'application/json',
                  headers: [],
                  mappings: [],
                  maxAttempts: 1,
                  method: 'GET',
                  query: [],
                  successStatusMaximum: 299,
                  successStatusMinimum: 200,
                  timeoutMs: 10_000,
                  url: 'https://',
                }
              : {},
    }));
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        void flowInstance?.fitView({ duration: 240, padding: 0.24 });
      });
    });
  };

  const connect = (connection: Connection) => {
    if (!connection.source || !connection.target) return;
    const source = nodes.find((node) => node.id === connection.source);
    const outgoing = edges.filter((edge) => edge.source === connection.source);
    const sourceType = String(source?.data.label);
    if (
      sourceType !== 'CONDITION' &&
      sourceType !== 'WAIT_FOR_REPLY' &&
      sourceType !== 'EXTERNAL_HTTP_REQUEST' &&
      outgoing.length
    ) {
      void message.warning('This output already has an active connection.');
      return;
    }
    const data: AutomationEdgeData =
      sourceType === 'CONDITION'
        ? {
            condition: { field: 'message.text', operator: 'exists' },
            output: `branch-${outgoing.length + 1}`,
            priority: outgoing.length,
          }
        : sourceType === 'WAIT_FOR_REPLY'
          ? { output: outgoing.length === 0 ? 'reply' : 'timeout' }
          : sourceType === 'EXTERNAL_HTTP_REQUEST'
            ? { output: outgoing.length === 0 ? 'success' : 'failure' }
            : { output: 'default' };
    captureHistory();
    setEdges((current) =>
      addEdge(
        {
          ...connection,
          data,
          label: automationEdgeLabel(data.output),
        },
        current,
      ),
    );
  };

  const save = async (values: { description?: string; name: string }) => {
    setManualSavePending(true);
    try {
      if (scenarioQuery.data) {
        const description = normalizeScenarioDescription(values.description, true);
        const updated = await mutations.update.mutateAsync({
          ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
          ...(description === undefined ? {} : { description }),
          id: scenarioQuery.data.id,
          graph,
          name: values.name,
        });
        setExpectedUpdatedAt(updated.updatedAt);
        setLastSavedSignature(
          automationEditorSignature(graph, values.name, description ?? undefined),
        );
        setSaveStatus('saved');
      } else {
        const description = normalizeScenarioDescription(values.description, false);
        const created = await mutations.create.mutateAsync({
          ...(typeof description === 'string' ? { description } : {}),
          graph,
          name: values.name,
        });
        void navigate(`/projects/${projectId}/scenarios/${created.id}`);
      }
      void message.success('Scenario draft saved.');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'SCENARIO_DRAFT_CONFLICT') {
        setSaveStatus('conflict');
        void message.error('This draft changed in another session. Reload before saving again.');
      } else void message.error(getUserErrorMessage(error, 'Scenario could not be saved.'));
    } finally {
      setManualSavePending(false);
    }
  };

  const applyEdgeChanges = (changes: EdgeChange[]) => {
    if (changes.some((change) => change.type === 'remove')) captureHistory();
    onEdgesChange(changes);
  };
  const applyNodeChanges = (changes: NodeChange[]) => {
    if (changes.some((change) => change.type === 'remove')) captureHistory();
    onNodesChange(changes);
  };

  const runTest = async (input: AutomationTestInput) => {
    try {
      const result = await mutations.testRun.mutateAsync({
        ...input,
        graph,
        scenarioId: scenarioQuery.data?.id ?? 'new',
      });
      setTestResult(result);
    } catch (error) {
      void message.error(automationActionErrorMessage(error));
    }
  };

  const publish = async () => {
    if (!scenarioQuery.data || hasBlockingValidation) return;
    try {
      await mutations.publish.mutateAsync(scenarioQuery.data.id);
      void message.success('Scenario published.');
    } catch (error) {
      void message.error(automationActionErrorMessage(error));
    }
  };

  return (
    <section>
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>
            {scenarioQuery.data?.name ?? 'New scenario'}
          </Typography.Title>
          <Typography.Text type="secondary">
            Design, validate and publish a deterministic customer journey.
          </Typography.Text>
        </div>
      </div>
      <Form
        className={`automation-editor${isFullscreen ? ' is-fullscreen' : ''}`}
        form={form}
        initialValues={{ name: '' }}
        layout="vertical"
        onFinish={save}
      >
        <div className="automation-fullscreen-toolbar">
          <div className="automation-fullscreen-title">
            <strong>{scenarioName || scenarioQuery.data?.name || 'New scenario'}</strong>
            {scenarioDescription ? <small>{scenarioDescription}</small> : null}
          </div>
          <Space wrap>
            <Button
              className="automation-editor-action-button"
              disabled={hasBlockingValidation}
              icon={<ExperimentOutlined />}
              type="default"
              onClick={() => setTestOpen(true)}
            >
              Test run
            </Button>
            <Button
              className="automation-editor-action-button"
              htmlType="submit"
              loading={mutations.create.isPending || manualSavePending}
              type="default"
            >
              Save draft
            </Button>
            {scenarioQuery.data ? (
              <Button
                className="automation-editor-action-button"
                disabled={hasBlockingValidation}
                loading={mutations.publish.isPending}
                type="primary"
                onClick={() => void publish()}
              >
                Publish
              </Button>
            ) : null}
            <Button
              aria-label="Exit full screen"
              icon={<FullscreenExitOutlined />}
              onClick={() => setIsFullscreen(false)}
            >
              Exit full screen
            </Button>
          </Space>
        </div>
        <Row className="automation-editor-fields" gutter={16}>
          <Col lg={10} xs={24}>
            <Form.Item label="Name" name="name" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
          </Col>
          <Col lg={10} xs={24}>
            <Form.Item label="Description" name="description">
              <Input />
            </Form.Item>
          </Col>
          <Col className="automation-fullscreen-trigger" lg={4} xs={24}>
            <Button
              aria-label="Enter full screen"
              block
              icon={<FullscreenOutlined />}
              onClick={() => setIsFullscreen(true)}
            >
              Full screen
            </Button>
          </Col>
        </Row>
        <Row className="automation-workspace" gutter={[16, 16]}>
          <Col className="scenario-editor-add-step-column" lg={6} xl={5} xs={24}>
            <Card className="automation-panel-card" size="small" title="Add a step">
              <Typography.Paragraph className="automation-panel-hint" type="secondary">
                Choose a step and place it on the canvas.
              </Typography.Paragraph>
              <Input
                allowClear
                className="automation-node-search"
                onChange={(event) => setPaletteSearch(event.target.value)}
                placeholder="Find a step"
                prefix={<SearchOutlined />}
                value={paletteSearch}
              />
              <Collapse
                className="node-palette"
                defaultActiveKey={paletteGroups.map((group) => group.key)}
                ghost
                items={filteredPaletteGroups.map((group) => ({
                  children: (
                    <div className="node-palette-items">
                      {group.nodes.map(([type, label]) => (
                        <Button
                          block
                          className="node-palette-item"
                          disabled={!isCanvasInteractive}
                          icon={automationNodeIcon(type)}
                          key={type}
                          onClick={() => addNode(type)}
                        >
                          {label}
                        </Button>
                      ))}
                    </div>
                  ),
                  key: group.key,
                  label: group.label,
                }))}
              />
            </Card>
          </Col>
          <Col lg={18} xl={13} xs={24}>
            <div aria-label="Scenario canvas" className="scenario-canvas">
              <div className="automation-canvas-toolbar">
                <Space size="small" wrap>
                  <Button
                    aria-label="Undo editor change"
                    disabled={!isCanvasInteractive || !historyPast.length}
                    icon={<UndoOutlined />}
                    onClick={undo}
                    size="small"
                  >
                    Undo
                  </Button>
                  <Button
                    aria-label="Redo editor change"
                    disabled={!isCanvasInteractive || !historyFuture.length}
                    icon={<RedoOutlined />}
                    onClick={redo}
                    size="small"
                  >
                    Redo
                  </Button>
                  <Button
                    disabled={!isCanvasInteractive || !selected}
                    icon={<CopyOutlined />}
                    onClick={copySelectedNode}
                    size="small"
                  >
                    Copy
                  </Button>
                  <Button
                    disabled={!isCanvasInteractive || !selected}
                    onClick={duplicateSelectedNode}
                    size="small"
                  >
                    Duplicate
                  </Button>
                </Space>
                <StatusText
                  label={
                    saveStatus === 'conflict'
                      ? 'Save conflict'
                      : manualSavePending
                        ? 'Saving…'
                        : draftDirty
                          ? 'Unsaved changes'
                          : 'Saved'
                  }
                  status={
                    saveStatus === 'conflict'
                      ? 'FAILED'
                      : manualSavePending
                        ? 'PROCESSING'
                        : draftDirty
                          ? 'DRAFT'
                          : 'SUCCEEDED'
                  }
                />
              </div>
              <ReactFlow
                connectionLineStyle={{ stroke: '#0f766e', strokeWidth: 2 }}
                defaultEdgeOptions={automationEdgeDefaults}
                edges={edges}
                deleteKeyCode={isCanvasInteractive ? ['Backspace', 'Delete'] : null}
                fitView
                fitViewOptions={{ padding: 0.24 }}
                maxZoom={1.6}
                minZoom={0.35}
                nodeTypes={automationNodeTypes}
                nodes={nodes}
                connectOnClick
                snapGrid={[20, 20]}
                snapToGrid
                nodesConnectable={isCanvasInteractive}
                nodesDraggable={isCanvasInteractive}
                elementsSelectable={isCanvasInteractive}
                panOnDrag={isCanvasInteractive}
                zoomOnDoubleClick={isCanvasInteractive}
                zoomOnPinch={isCanvasInteractive}
                zoomOnScroll={isCanvasInteractive}
                onInit={(instance) => {
                  setFlowInstance(instance);
                }}
                onConnect={connect}
                onEdgeClick={(_, edge) => {
                  setSelectedEdgeId(edge.id);
                  setSelectedId(undefined);
                }}
                onEdgesChange={applyEdgeChanges}
                onNodeClick={(_, node) => {
                  setSelectedId(node.id);
                  setSelectedEdgeId(undefined);
                }}
                onNodeDragStart={captureHistory}
                onNodesChange={applyNodeChanges}
                proOptions={{ hideAttribution: true }}
              >
                <Background color="#dbe5ef" gap={22} size={1.2} />
                <Controls
                  className="automation-flow-controls"
                  onInteractiveChange={setIsCanvasInteractive}
                  showFitView={isCanvasInteractive}
                  showZoom={isCanvasInteractive}
                />
                <MiniMap
                  className="automation-flow-minimap"
                  maskColor="rgba(241, 245, 249, 0.78)"
                  nodeColor="#99c9c4"
                  style={{ height: 75, width: 100 }}
                />
              </ReactFlow>
            </div>
          </Col>
          <Col className="scenario-editor-settings-column" lg={24} xl={6} xs={24}>
            <Card
              className="automation-panel-card"
              size="small"
              title={selected ? 'Node settings' : selectedEdge ? 'Connection settings' : 'Settings'}
            >
              {selected ? (
                <div className="automation-node-settings">
                  <header className="automation-settings-heading">
                    <span className="automation-settings-icon">
                      {automationNodeIcon(String(selected.data.label))}
                    </span>
                    <span>
                      <strong>{automationNodeLabel(String(selected.data.label))}</strong>
                      <small>{automationNodeDescription(String(selected.data.label))}</small>
                    </span>
                  </header>
                  <div className="automation-settings-content">
                    {!isCanvasInteractive ? (
                      <div className="automation-settings-readonly">
                        Canvas is locked. Unlock it to edit this step.
                      </div>
                    ) : (
                      <AutomationNodeConfig
                        config={configs[selected.id] ?? {}}
                        customFields={customFields.data ?? []}
                        nodeType={String(selected.data.label)}
                        onCreateSecret={async (name, value) => {
                          const created = await automationHttp.createSecret.mutateAsync({
                            name,
                            value,
                          });
                          return created.id;
                        }}
                        onChange={(config) => {
                          captureHistory();
                          setConfigs((current) => ({ ...current, [selected.id]: config }));
                        }}
                        projectId={projectId}
                        scenarioId={scenarioId}
                        scenarios={(scenarios.data ?? []).filter(
                          (candidate) => candidate.id !== scenarioId,
                        )}
                        secrets={automationSecrets.data ?? []}
                        tags={tags.data ?? []}
                        templates={templates.data ?? []}
                        emailTemplates={emailTemplates.data ?? []}
                        testHttpRequest={async (config, variables) =>
                          automationHttp.testRequest.mutateAsync({
                            config,
                            ...(variables ? { variables } : {}),
                          })
                        }
                      />
                    )}
                  </div>
                  {String(selected.data.label) !== 'INCOMING_MESSAGE' ? (
                    <footer className="automation-settings-footer">
                      <Button
                        danger
                        disabled={!isCanvasInteractive}
                        onClick={() => {
                          captureHistory();
                          setNodes((current) => current.filter((node) => node.id !== selected.id));
                          setEdges((current) =>
                            current.filter(
                              (edge) => edge.source !== selected.id && edge.target !== selected.id,
                            ),
                          );
                          setSelectedId(undefined);
                        }}
                      >
                        Delete node
                      </Button>
                    </footer>
                  ) : null}
                </div>
              ) : selectedEdge ? (
                <div className="automation-node-settings">
                  <header className="automation-settings-heading is-connection">
                    <BranchesOutlined />
                    <span>
                      <strong>
                        {nodeLabels[selectedEdge.source] ?? 'Source'} →{' '}
                        {nodeLabels[selectedEdge.target] ?? 'Target'}
                      </strong>
                      <small>Configure the output and optional branch rules.</small>
                    </span>
                  </header>
                  <div className="automation-settings-content">
                    {!isCanvasInteractive ? (
                      <div className="automation-settings-readonly">
                        Canvas is locked. Unlock it to edit this connection.
                      </div>
                    ) : (
                      <EdgeConfiguration
                        customFields={customFields.data ?? []}
                        edge={selectedEdge}
                        onChange={(next) => {
                          captureHistory();
                          setEdges((current) =>
                            current.map((edge) => (edge.id === next.id ? next : edge)),
                          );
                        }}
                        sourceType={String(
                          nodes.find((node) => node.id === selectedEdge.source)?.data.label ?? '',
                        )}
                      />
                    )}
                  </div>
                  <footer className="automation-settings-footer">
                    <Button
                      danger
                      disabled={!isCanvasInteractive}
                      onClick={() => {
                        captureHistory();
                        setEdges((current) =>
                          current.filter((edge) => edge.id !== selectedEdge.id),
                        );
                        setSelectedEdgeId(undefined);
                      }}
                    >
                      Delete connection
                    </Button>
                  </footer>
                </div>
              ) : (
                <div className="automation-settings-empty">
                  <SettingOutlined />
                  <strong>Nothing selected</strong>
                  <Typography.Text type="secondary">
                    Select a step or connection on the canvas to configure it.
                  </Typography.Text>
                </div>
              )}
            </Card>
          </Col>
        </Row>
        <Space className="automation-actions" wrap>
          <Button
            className="automation-editor-action-button"
            disabled={hasBlockingValidation}
            icon={<ExperimentOutlined />}
            type="default"
            onClick={() => setTestOpen(true)}
          >
            Test run
          </Button>
          <Button
            className="automation-editor-action-button"
            htmlType="submit"
            loading={mutations.create.isPending || manualSavePending}
            type="default"
          >
            Save draft
          </Button>
          {scenarioQuery.data ? (
            <Button
              className="automation-editor-action-button"
              disabled={hasBlockingValidation}
              loading={mutations.publish.isPending}
              type="primary"
              onClick={() => void publish()}
            >
              Publish
            </Button>
          ) : null}
        </Space>
      </Form>
      <section
        className={`automation-validation-panel${validationErrors.length ? ' has-errors' : ''}`}
      >
        <header>
          {validationErrors.length ? <ExclamationCircleOutlined /> : <CheckCircleOutlined />}
          <span>
            <strong>
              {validationErrors.length
                ? `${validationErrors.length} ${validationErrors.length === 1 ? 'fix' : 'fixes'} needed`
                : validationWarnings.length
                  ? `Ready to publish · ${validationWarnings.length} ${validationWarnings.length === 1 ? 'warning' : 'warnings'}`
                  : 'Ready to publish'}
            </strong>
            <small>
              {validationErrors.length
                ? 'The draft is saved, but publish and safe test stay blocked.'
                : 'Draft structure is valid.'}
            </small>
          </span>
        </header>
        {validationErrors.length || validationWarnings.length ? (
          <details open={validationErrors.length > 0}>
            <summary>Review validation details</summary>
            <div className="automation-validation-issues">
              {[
                ...validationErrors.map((issue) => ({ ...issue, level: 'error' as const })),
                ...validationWarnings.map((issue) => ({ ...issue, level: 'warning' as const })),
              ].map((issue, index) => (
                <button
                  className={`automation-validation-issue is-${issue.level}`}
                  key={`${issue.level}-${issue.message}-${index}`}
                  onClick={() => {
                    const edgeId =
                      'edgeId' in issue && typeof issue.edgeId === 'string'
                        ? issue.edgeId
                        : undefined;
                    if (edgeId) {
                      setSelectedEdgeId(edgeId);
                      setSelectedId(undefined);
                    } else if (issue.nodeId) {
                      setSelectedId(issue.nodeId);
                      setSelectedEdgeId(undefined);
                    }
                  }}
                  type="button"
                >
                  <span>{issue.level === 'error' ? 'Fix' : 'Note'}</span>
                  {issue.message}
                </button>
              ))}
            </div>
          </details>
        ) : null}
      </section>
      {scenarioQuery.data ? (
        <>
          <Typography.Title className="automation-section-title" level={4}>
            Version history
          </Typography.Title>
          <Table
            className="automation-version-table"
            columns={[
              {
                key: 'preview',
                title: 'Canvas',
                width: 154,
                render: (_, version) => (
                  <button
                    aria-label={`Preview version ${version.version}`}
                    className="automation-version-preview-button"
                    onClick={() => setPreviewVersion(version)}
                    type="button"
                  >
                    <AutomationGraphPreview compact graph={version.graph} />
                  </button>
                ),
              },
              {
                className: 'automation-version-table-version-column',
                dataIndex: 'version',
                title: 'Version',
              },
              {
                dataIndex: 'status',
                title: 'Status',
                render: (value, version) => (
                  <Space size={11}>
                    <StatusText label={automationVersionStatus(value)} status={value} />
                    {version.id === scenarioQuery.data?.draftVersion?.id ||
                    (!scenarioQuery.data?.draftVersion &&
                      version.id === scenarioQuery.data?.activeVersion?.id) ? (
                      <Tag color="cyan">Current</Tag>
                    ) : null}
                  </Space>
                ),
              },
              {
                dataIndex: 'publishedAt',
                title: 'Published',
                render: (value) => (value ? new Date(value).toLocaleString() : '—'),
              },
              {
                key: 'restore',
                render: (_, version) =>
                  version.id === scenarioQuery.data?.draftVersion?.id ||
                  (!scenarioQuery.data?.draftVersion &&
                    version.id === scenarioQuery.data?.activeVersion?.id) ? null : (
                    <Button
                      onClick={async () => {
                        try {
                          await mutations.restoreVersion.mutateAsync({
                            scenarioId: scenarioQuery.data!.id,
                            versionId: version.id,
                          });
                          void message.success('Version restored to a new draft.');
                        } catch (error) {
                          void message.error(
                            getUserErrorMessage(error, 'Version could not be restored.'),
                          );
                        }
                      }}
                      size="small"
                    >
                      Restore to draft
                    </Button>
                  ),
              },
            ]}
            dataSource={scenarioQuery.data.versions ?? []}
            pagination={false}
            rowKey="id"
          />
          <div className="automation-section-heading automation-section-heading--with-space">
            <Typography.Title className="automation-section-title" level={4}>
              Execution inspector
            </Typography.Title>
            <Button
              icon={<SyncOutlined />}
              loading={executions.isFetching}
              onClick={() => void executions.refetch()}
              size="small"
            >
              Refresh
            </Button>
          </div>
          <Table
            columns={[
              {
                dataIndex: 'createdAt',
                render: (value) => new Date(value).toLocaleString(),
                title: 'Started',
              },
              {
                dataIndex: 'status',
                title: 'Status',
                render: (value) => (
                  <StatusText label={automationExecutionStatus(value)} status={value} />
                ),
              },
              {
                dataIndex: 'currentNodeId',
                title: 'Current node',
                render: (value) => (value ? (nodeLabels[value] ?? value) : 'Completed'),
              },
            ]}
            dataSource={executions.data ?? []}
            loading={executions.isLoading}
            onRow={(record) => ({ onClick: () => setInspectedExecution(record) })}
            pagination={false}
            rowKey="id"
          />
        </>
      ) : null}
      <Drawer
        onClose={() => setInspectedExecution(undefined)}
        open={Boolean(inspectedExecution)}
        title="Execution details"
        width={520}
      >
        {inspectedExecution ? (
          <>
            <Descriptions
              column={1}
              items={[
                { children: inspectedExecution.id, key: 'id', label: 'Execution' },
                {
                  children: automationExecutionStatus(inspectedExecution.status),
                  key: 'status',
                  label: 'Status',
                },
                {
                  children: inspectedExecution.currentNodeId
                    ? (nodeLabels[inspectedExecution.currentNodeId] ??
                      inspectedExecution.currentNodeId)
                    : 'Completed',
                  key: 'current',
                  label: 'Current node',
                },
              ]}
            />
            <Timeline
              items={inspectedExecution.nodeExecutions.map((node) => ({
                children: (
                  <Space direction="vertical" size={0}>
                    <Typography.Text strong>{automationNodeLabel(node.nodeType)}</Typography.Text>
                    <Typography.Text type="secondary">
                      {automationNodeStepStatus(node.status)} · attempt {node.attempt}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      {executionDuration(node.startedAt, node.completedAt)}
                    </Typography.Text>
                    {node.delivery ? (
                      <div
                        className={`automation-delivery-status is-${node.delivery.messageStatus.toLowerCase()}`}
                      >
                        <strong>{automationDeliveryStatus(node.delivery.messageStatus)}</strong>
                        <small>
                          Channel delivery · outbox {node.delivery.outboxStatus.toLowerCase()}
                        </small>
                      </div>
                    ) : null}
                    <details className="automation-technical-details">
                      <summary>Technical details</summary>
                      <code>{node.nodeId}</code>
                    </details>
                    {safeDiagnosticJson(node.inputSafe) ? (
                      <details>
                        <summary>Safe input</summary>
                        <pre className="automation-diagnostic-json">
                          {safeDiagnosticJson(node.inputSafe)}
                        </pre>
                      </details>
                    ) : null}
                    {safeDiagnosticJson(node.outputSafe) ? (
                      <details>
                        <summary>Safe output</summary>
                        <pre className="automation-diagnostic-json">
                          {safeDiagnosticJson(node.outputSafe)}
                        </pre>
                      </details>
                    ) : null}
                    {safeDiagnosticJson(node.errorSafe) ? (
                      <details>
                        <summary>Safe error</summary>
                        <pre className="automation-diagnostic-json">
                          {safeDiagnosticJson(node.errorSafe)}
                        </pre>
                      </details>
                    ) : null}
                  </Space>
                ),
                color:
                  node.status === 'SUCCEEDED' ? 'green' : node.status === 'FAILED' ? 'red' : 'blue',
              }))}
            />
            <Button
              icon={<ExperimentOutlined />}
              loading={mutations.replayExecution.isPending}
              onClick={async () => {
                try {
                  const result = await mutations.replayExecution.mutateAsync({
                    executionId: inspectedExecution.id,
                    scenarioId: scenarioQuery.data!.id,
                  });
                  setTestResult(result);
                  setInspectedExecution(undefined);
                  setTestOpen(true);
                } catch (error) {
                  void message.error(
                    getUserErrorMessage(error, 'Execution could not be replayed safely.'),
                  );
                }
              }}
            >
              Replay as safe test
            </Button>
          </>
        ) : null}
      </Drawer>
      <Modal
        footer={null}
        onCancel={() => setPreviewVersion(undefined)}
        open={Boolean(previewVersion)}
        title={previewVersion ? `Version ${previewVersion.version} canvas` : 'Version canvas'}
        width={780}
      >
        {previewVersion ? <AutomationGraphPreview graph={previewVersion.graph} /> : null}
      </Modal>
      <Modal
        footer={null}
        onCancel={() => {
          setUnsavedLeaveModalOpen(false);
          setUnsavedLeaveUrl(undefined);
        }}
        open={unsavedLeaveModalOpen}
        title="Leave without saving?"
      >
        <Typography.Paragraph type="secondary">
          This scenario has unsaved changes. If you leave now, all unsaved edits will be lost.
        </Typography.Paragraph>
        <div className="modal-form-actions">
          <Button onClick={() => setUnsavedLeaveModalOpen(false)}>Cancel</Button>
          <Button
            type="primary"
            onClick={() => {
              if (!unsavedLeaveUrl) return;
              skipBeforeUnloadRef.current = true;
              const targetUrl = new URL(unsavedLeaveUrl, window.location.origin);
              setUnsavedLeaveModalOpen(false);
              setUnsavedLeaveUrl(undefined);
              if (targetUrl.origin !== window.location.origin) {
                window.location.href = targetUrl.href;
              } else {
                navigate(`${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`);
              }
            }}
          >
            Leave anyway
          </Button>
        </div>
      </Modal>
      <Drawer onClose={() => setTestOpen(false)} open={testOpen} title="Safe test run" width={560}>
        <AutomationTestPanel
          loading={mutations.testRun.isPending}
          nodeLabels={nodeLabels}
          nodeTypes={graph.nodes.map((node) => node.type)}
          onRun={runTest}
          {...(testResult ? { result: testResult } : {})}
          validationErrors={validationErrors.map((issue) => issue.message)}
        />
      </Drawer>
    </section>
  );
}

function EdgeConfiguration({
  customFields,
  edge,
  onChange,
  sourceType,
}: {
  customFields: AutomationCustomField[];
  edge: Edge;
  onChange(edge: Edge): void;
  sourceType: string;
}) {
  const data = (edge.data ?? {}) as AutomationEdgeData;
  const update = (next: Partial<AutomationEdgeData>) => {
    const merged = { ...data, ...next };
    onChange({
      ...edge,
      data: merged,
      label: merged.output === 'default' ? undefined : merged.output,
    });
  };
  const replaceData = (next: AutomationEdgeData) =>
    onChange({
      ...edge,
      data: next,
      label: next.output === 'default' ? undefined : next.output,
    });
  const fallback = !data.condition && !data.conditionGroup;
  const conditionGroup: NonNullable<AutomationEdgeData['conditionGroup']> = data.conditionGroup ?? {
    combinator: 'AND',
    rules: [data.condition ?? { field: 'message.text', operator: 'exists' }],
  };
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Form.Item label="Output port">
        {sourceType === 'WAIT_FOR_REPLY' || sourceType === 'EXTERNAL_HTTP_REQUEST' ? (
          <Select
            onChange={(output: string) => update({ output })}
            options={
              sourceType === 'WAIT_FOR_REPLY'
                ? [
                    { label: 'Reply matched', value: 'reply' },
                    { label: 'Timed out', value: 'timeout' },
                  ]
                : [
                    { label: 'Request succeeded', value: 'success' },
                    { label: 'Request failed', value: 'failure' },
                  ]
            }
            value={data.output ?? null}
          />
        ) : (
          <Input onChange={(event) => update({ output: event.target.value })} value={data.output} />
        )}
      </Form.Item>
      {data.priority !== undefined ? (
        <>
          <Form.Item label="Branch priority">
            <InputNumber
              min={0}
              onChange={(value) => update({ priority: value ?? 0 })}
              value={data.priority}
            />
          </Form.Item>
          <Checkbox
            checked={fallback}
            onChange={(event) => {
              const rest = { ...data };
              delete rest.condition;
              delete rest.conditionGroup;
              replaceData(
                event.target.checked
                  ? rest
                  : {
                      ...rest,
                      conditionGroup: {
                        combinator: 'AND',
                        rules: [{ field: 'message.text', operator: 'exists' }],
                      },
                    },
              );
            }}
          >
            Fallback branch when no rules match
          </Checkbox>
          {!fallback ? (
            <AutomationConditionGroupFields
              customFields={customFields}
              group={conditionGroup}
              onChange={(nextGroup) => {
                const rest = { ...data };
                delete rest.condition;
                delete rest.conditionGroup;
                replaceData({ ...rest, conditionGroup: nextGroup });
              }}
            />
          ) : null}
        </>
      ) : null}
    </Space>
  );
}

function executionDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return 'Not started';
  if (!completedAt) return `Started ${new Date(startedAt).toLocaleString()}`;
  const milliseconds = Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
  return `${milliseconds} ms`;
}

function automationVersionStatus(status: string): string {
  if (status === 'PUBLISHED') return 'Published';
  if (status === 'SUPERSEDED') return 'Previous';
  if (status === 'DRAFT') return 'Draft';
  return status.toLowerCase().replaceAll('_', ' ');
}

function automationExecutionStatus(status: string): string {
  const labels: Record<string, string> = {
    CANCELLED: 'Cancelled',
    COMPLETED: 'Completed',
    FAILED: 'Failed',
    QUEUED: 'Queued',
    RUNNING: 'Running',
    WAITING: 'Waiting',
  };
  return labels[status] ?? status.toLowerCase().replaceAll('_', ' ');
}

function automationNodeStepStatus(status: string): string {
  if (status === 'SUCCEEDED') return 'Step completed';
  if (status === 'FAILED') return 'Step failed';
  if (status === 'PROCESSING') return 'Processing';
  return status.toLowerCase().replaceAll('_', ' ');
}

function automationDeliveryStatus(status: string): string {
  const labels: Record<string, string> = {
    CANCELLED: 'Delivery cancelled',
    FAILED: 'Delivery failed',
    PROCESSING: 'Sending to the channel',
    QUEUED: 'Queued for channel delivery',
    SENT: 'Sent by the channel provider',
    UNKNOWN: 'Delivery outcome unknown',
  };
  return labels[status] ?? `Delivery ${status.toLowerCase().replaceAll('_', ' ')}`;
}
