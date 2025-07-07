class ErrorHandler extends Error{
    constructor(statusCode,message,detail,originalError = null){
        super();
        this.statusCode = statusCode;
        this.message = message;
        this.detail = detail;
        this.originalError = originalError;
    }
}

module.exports = ErrorHandler;