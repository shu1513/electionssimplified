export type ApiErrorCode =
  | "not_found"
  | "method_not_allowed"
  | "unauthorized"
  | "forbidden"
  | "invalid_json"
  | "invalid_request"
  | "unsupported_media_type"
  | "rate_limited"
  // Google login intent found no account: the frontend routes to signup.
  | "needs_signup"
  | "follow_limit_reached"
  // Monthly checkout attempted while a live membership exists: the frontend
  // points at Manage membership instead of a generic error.
  | "membership_exists"
  // Manage-page actions (docs/plans/membership-manage-page.md): a cancel
  // while the first payment is still confirming, or a subscription that no
  // longer matches our records. Both 409.
  | "membership_pending"
  | "membership_conflict"
  | "address_not_found"
  // ZIP partial-ballot failures (docs/plans/partial-address-scope.md): each
  // needs different client copy, so they are not folded into
  // address_not_found. All 422.
  | "full_address_required"
  | "zip_not_found"
  | "zip_multi_state"
  | "zip_unsupported_region"
  | "zip_required_for_po_box"
  | "region_unsupported"
  | "districts_unavailable"
  | "upstream_unavailable"
  | "bad_upstream_response"
  | "internal_error";

export type ApiErrorBody = {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Present on unexpected (5xx) failures: correlates the response with
     * the server-side error log line for that request. */
    request_id?: string;
  };
};

export type ApiResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body?: unknown;
};

export function toJsonResponse(
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): ApiResponse {
  return {
    statusCode,
    headers: {
      ...extraHeaders,
      "content-type": "application/json; charset=utf-8",
    },
    body,
  };
}

export function toXmlResponse(
  statusCode: number,
  body: string,
  extraHeaders: Record<string, string> = {}
): ApiResponse {
  return {
    statusCode,
    headers: {
      ...extraHeaders,
      "content-type": "application/xml; charset=utf-8",
    },
    body,
  };
}

export function toPngResponse(
  statusCode: number,
  body: Buffer,
  extraHeaders: Record<string, string> = {}
): ApiResponse {
  return {
    statusCode,
    headers: {
      ...extraHeaders,
      "content-type": "image/png",
    },
    body,
  };
}

export function toEmptyResponse(statusCode: number, extraHeaders: Record<string, string> = {}): ApiResponse {
  return {
    statusCode,
    headers: extraHeaders,
  };
}

export function toErrorResponse(
  statusCode: number,
  code: ApiErrorCode,
  message: string,
  extraHeaders: Record<string, string> = {}
): ApiResponse {
  return toJsonResponse(
    statusCode,
    {
      error: {
        code,
        message,
      },
    } satisfies ApiErrorBody,
    extraHeaders
  );
}
