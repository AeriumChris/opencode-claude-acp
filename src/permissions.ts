import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

export type Approval = { label: string; description: string; optionId?: string; allowAll?: boolean };
const compact = (text: string, limit: number) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};

export function permissionSummary({ toolCall }: RequestPermissionRequest): string {
  const lines = [`Claude Code requests permission: ${compact(toolCall.title ?? toolCall.toolCallId, 160)}`];
  const input = toolCall.rawInput;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const fields = input as Record<string, unknown>;
    const path = fields.file_path ?? fields.path;
    if (typeof path === 'string') lines.push(`Path: ${compact(path, 180)}`);
    if (typeof fields.command === 'string') lines.push(`Command: ${compact(fields.command, 240)}`);
    if (typeof fields.content === 'string') lines.push(`File content: ${fields.content.length} characters (omitted).`);
    else if (fields.old_string !== undefined || fields.new_string !== undefined) lines.push('Edit content omitted.');
  }
  lines.push('Allow this operation?');
  return lines.join('\n');
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
