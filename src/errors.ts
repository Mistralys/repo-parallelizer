/**
 * Thrown by manager-layer methods when a requested entity (project, repository,
 * workspace) does not exist.  Route handlers use `instanceof NotFoundError` to
 * distinguish 404 responses from other error categories (validation, protection).
 */
export class NotFoundError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NotFoundError';
    }
}
