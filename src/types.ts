export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_input'
  | 'cancel_requested'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown';
export type Outcome = 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export interface ModelSelection {
  providerId: string;
  modelId: string;
  variant?: string;
  thinking?: { effort: string };
}
export interface Device {
  id: string;
  name: string;
  version: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
}
export interface Project {
  id: string;
  deviceId: string;
  name: string;
  sessionId: string;
  workspaceDir: string;
  workspaceKey: string;
  model: ModelSelection | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}
export interface Task {
  id: string;
  projectId: string;
  deviceId: string;
  sessionId: string;
  workspaceKey: string;
  requestKey: string;
  prompt: string;
  acceptanceCriteria: string[];
  runVerification: boolean;
  parentTaskId: string | null;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  leaseExpiresAt: number | null;
  lastSequence: number;
  result: Json | null;
  error: string | null;
}
export interface SubmitTask {
  projectId: string;
  requestKey: string;
  prompt: string;
  acceptanceCriteria?: string[];
  runVerification?: boolean;
  parentTaskId?: string;
}
export interface WorkerEvent {
  sequence: number;
  type: string;
  time?: number;
  payload: Json;
}
export interface StoredEvent extends WorkerEvent {
  receivedAt: number;
}
export type CommandKind = 'cancel' | 'steer' | 'reply' | 'answer';
export interface TaskCommand {
  id: string;
  taskId: string;
  kind: CommandKind;
  payload: Json;
  status: 'pending' | 'applied' | 'rejected' | 'unknown';
  requestKey: string;
  createdAt: number;
  updatedAt: number;
  message: string | null;
}
export interface Assignment {
  task: Task;
  project: Project;
  leaseToken: string;
}
export interface ProjectInput {
  projectId?: string;
  name: string;
  sessionId: string;
  workspaceDir: string;
  workspaceKey: string;
  model?: ModelSelection;
}
export interface Principal {
  id: string;
  scopes: string[];
  clientId: string;
}
