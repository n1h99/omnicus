/** Server-only scope. Integration controllers continue to pass a project ID string. */
export interface NativeCommunicationScope {
  projectId: string;
  source: 'omnicus';
}

export type CommunicationProjectScope = string | NativeCommunicationScope;
