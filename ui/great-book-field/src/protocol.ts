export interface GreatBookFieldProjectionMessage {
  type: 'great-book-field.projection';
  payload: unknown;
}

export function isProjectionMessage(value: unknown): value is GreatBookFieldProjectionMessage {
  return !!value && typeof value === 'object' && (value as { type?: string }).type === 'great-book-field.projection';
}
