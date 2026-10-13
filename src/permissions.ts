import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

export type Approval = { label: string; description: string; optionId?: string; allowAll?: boolean };
/** Use native host actions so agent rules and the UI auto-approver apply. */
export function nativePermission({ toolCall }: RequestPermissionRequest) {
  const input = toolCall.rawInput && typeof toolCall.rawInput === 'object' ? toolCall.rawInput as Record<string, unknown> : {};
  const action = ({ execute: 'shell', read: 'read', edit: 'edit', delete: 'edit', search: 'grep', fetch: 'webfetch' } as Record<string, string>)[toolCall.kind ?? ''] ?? 'claude_code';
  const paths = toolCall.locations?.map((location) => location.path) ?? [];
  const resource = action === 'shell' ? input.command : action === 'webfetch' ? input.url : input.file_path ?? input.path;
  const resources = (action === 'shell' || action === 'webfetch') && typeof resource === 'string' ? [resource] :
    paths.length ? paths : [typeof resource === 'string' ? resource : toolCall.title || toolCall.toolCallId];
  return { action, resources, save: resources, metadata: { title: toolCall.title, claudeToolCallID: toolCall.toolCallId } };
}
const compact = (text: string, limit: number) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};

export function permissionSummary({ toolCall }: RequestPermissionRequest): string {
  return `Claude Code requests permission: ${compact(toolCall.title ?? toolCall.toolCallId, 160)}`;
}

export function permissionChoices(request: RequestPermissionRequest): Approval[] {
  const choices: Approval[] = [{ label: 'Deny', description: 'Do not run this operation.',
    optionId: request.options.find((option) => option.kind === 'reject_once')?.optionId }];
  const once = request.options.find((option) => option.kind === 'allow_once');
  if (once) choices.push({ label: 'Allow once', description: 'Approve this one Claude Code operation.', optionId: once.optionId });
  const always = request.options.filter((option) => option.kind === 'allow_always');
  always.forEach((option, index) => choices.push({
    label: index === 0 ? 'Allow always' : `Allow always (${index + 1})`,
    description: compact(option.name, 200), optionId: option.optionId,
  }));
  if (once || always.length) choices.push({ label: 'Allow all (session)',
    description: 'Approve all Claude ACP operations in this session, including future turns.',
    optionId: (once ?? always[0])!.optionId, allowAll: true });
  return choices;
}

export function allowPermission(request: RequestPermissionRequest): RequestPermissionResponse {
  const option = request.options.find((option) => option.kind === 'allow_once') ??
    request.options.find((option) => option.kind === 'allow_always');
  return permissionResponse(option?.optionId);
}

export function permissionResponse(optionId?: string): RequestPermissionResponse {
  return optionId === undefined ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId } };
}
