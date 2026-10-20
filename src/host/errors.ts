export class DeleteError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DeleteError';
    this.code = code;
  }
}

export function refuse(code: string, message: string): never {
  throw new DeleteError(code, message);
}
