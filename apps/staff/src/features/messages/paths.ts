/** The one path this feature serves (the navigation item "Tasks & messages" already points here). It carries no record identifier. */
export const MESSAGES_PATHS = ['/tasks'] as const;
export type MessagesPath = (typeof MESSAGES_PATHS)[number];
export const isMessagesPath = (path: string): path is MessagesPath =>
  (MESSAGES_PATHS as readonly string[]).includes(path);
