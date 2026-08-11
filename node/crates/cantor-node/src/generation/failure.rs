use cantor_proto::ErrorCode;

pub(crate) struct WorkerFailure {
    pub(crate) code: ErrorCode,
    pub(crate) retryable: bool,
    pub(crate) public_message: &'static str,
    pub(crate) source: anyhow::Error,
}

impl WorkerFailure {
    pub(crate) fn permanent(code: ErrorCode, public_message: &'static str) -> Self {
        Self::with_source(code, false, public_message, anyhow::anyhow!(public_message))
    }

    pub(crate) fn internal(public_message: &'static str) -> Self {
        Self::with_source(
            ErrorCode::Internal,
            true,
            public_message,
            anyhow::anyhow!(public_message),
        )
    }

    pub(crate) fn from_internal(source: anyhow::Error) -> Self {
        Self::with_source(
            ErrorCode::Internal,
            true,
            "The node could not safely execute this generation.",
            source,
        )
    }

    pub(crate) fn with_source(
        code: ErrorCode,
        retryable: bool,
        public_message: &'static str,
        source: anyhow::Error,
    ) -> Self {
        Self {
            code,
            retryable,
            public_message,
            source,
        }
    }
}
