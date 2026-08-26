export class ViewRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViewRuntimeError";
  }
}

export class ViewNotFoundError extends ViewRuntimeError {
  constructor(viewKey: string) {
    super(`View 不存在或未启用：${viewKey}`);
    this.name = "ViewNotFoundError";
  }
}

export class ViewConflictError extends ViewRuntimeError {
  constructor(message = "View stateVersion 已变化") {
    super(message);
    this.name = "ViewConflictError";
  }
}

/** A syntactically valid Command that cannot be applied to the current graph. */
export class ViewCommandValidationError extends ViewRuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "ViewCommandValidationError";
  }
}
