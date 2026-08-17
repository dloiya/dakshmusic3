class AppError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class NotFoundError(AppError):
    def __init__(self, message: str = "Resource not found"):
        super().__init__(message, 404)


class ConflictError(AppError):
    def __init__(self, message: str = "Resource conflict"):
        super().__init__(message, 409)
