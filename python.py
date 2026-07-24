#!/usr/bin/env python3

import json
import os
import subprocess
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import requests


PROJECT_ID = os.environ.get(
    "GOOGLE_CLOUD_PROJECT",
    "arcane-attic-499510-d2",
)

VERTEX_LOCATION = os.environ.get(
    "VERTEX_LOCATION",
    "global",
)

DEFAULT_VERTEX_MODEL = os.environ.get(
    "VERTEX_MODEL",
    "gemini-2.5-flash",
)

PORT = int(os.environ.get("PORT", "8080"))

LOG_REQUESTS = os.environ.get(
    "LOG_REQUESTS",
    "0",
).lower() in ("1", "true", "yes")


# Client-facing model names mapped to actual Vertex AI models.
MODEL_MAP = {
    "openai/o4-mini": "gemini-2.5-flash",
    "openai/gpt-4o": "gemini-2.5-flash",
    "openai/gpt-4o-mini": "gemini-2.5-flash",

    "google/gemini-2.5-flash": "gemini-2.5-flash",
    "google/gemini-2.0-flash": "gemini-2.0-flash",

    "gemini-2.5-flash": "gemini-2.5-flash",
    "gemini-2.0-flash": "gemini-2.0-flash",
    "gemini-1.5-flash": "gemini-1.5-flash",
    "gemini-1.5-pro": "gemini-1.5-pro",
    "gemini-pro": "gemini-1.5-pro",
}


def timestamp():
    return int(time.time())


def make_id(prefix="gen"):
    return f"{prefix}-{timestamp()}-{uuid.uuid4().hex[:20]}"


def make_openai_error(
    message,
    error_type="server_error",
    code=None,
):
    return {
        "error": {
            "message": str(message),
            "type": error_type,
            "param": None,
            "code": code,
        }
    }


def extract_text(content):
    """
    Supports:

    "content": "hello"

    and:

    "content": [
        {"type": "text", "text": "hello"},
        {"type": "text", "text": "world"}
    ]
    """

    if content is None:
        return ""

    if isinstance(content, str):
        return content

    if isinstance(content, list):
        result = []

        for item in content:
            if not isinstance(item, dict):
                continue

            if item.get("type") == "text":
                result.append(
                    str(item.get("text", ""))
                )
            elif "text" in item:
                result.append(
                    str(item.get("text", ""))
                )

        return "".join(result)

    return str(content)


def get_access_token():
    """
    Cloud Run uses the metadata server.

    Local development uses gcloud authentication.
    """

    direct_token = os.environ.get(
        "GOOGLE_ACCESS_TOKEN"
    )

    if direct_token:
        return direct_token

    metadata_url = (
        "http://metadata.google.internal/computeMetadata/v1/"
        "instance/service-accounts/default/token"
    )

    try:
        response = requests.get(
            metadata_url,
            headers={
                "Metadata-Flavor": "Google",
            },
            timeout=5,
        )

        if response.ok:
            token = response.json().get(
                "access_token"
            )

            if token:
                return token
    except Exception:
        pass

    commands = [
        ["gcloud", "auth", "print-access-token"],
        [
            "gcloud",
            "auth",
            "application-default",
            "print-access-token",
        ],
    ]

    for command in commands:
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=10,
            )

            if result.returncode == 0:
                token = result.stdout.strip()

                if token:
                    return token
        except Exception:
            pass

    return None


def sanitize_vertex_schema(schema):
    """
    Vertex AI supports only a subset of JSON Schema.

    This removes unsupported fields such as:

    $schema
    $id
    $ref
    $defs
    definitions
    exclusiveMinimum
    exclusiveMaximum
    additionalProperties
    anyOf
    oneOf
    allOf
    const
    examples
    default
    """

    if not isinstance(schema, dict):
        return {
            "type": "STRING",
        }

    # Convert nullable anyOf/oneOf schemas into Vertex format.
    for union_key in ("anyOf", "oneOf"):
        union = schema.get(union_key)

        if isinstance(union, list) and union:
            non_null_items = [
                item
                for item in union
                if isinstance(item, dict)
                and item.get("type") != "null"
            ]

            if non_null_items:
                result = sanitize_vertex_schema(
                    non_null_items[0]
                )

                contains_null = any(
                    isinstance(item, dict)
                    and item.get("type") == "null"
                    for item in union
                )

                if contains_null:
                    result["nullable"] = True

                return result

    # Use the first schema for allOf.
    all_of = schema.get("allOf")

    if isinstance(all_of, list) and all_of:
        for item in all_of:
            if isinstance(item, dict):
                return sanitize_vertex_schema(item)

    # Convert const to enum.
    if "const" in schema:
        constant = schema.get("const")

        return {
            "type": "STRING",
            "enum": [constant],
        }

    allowed_fields = {
        "type",
        "format",
        "title",
        "description",
        "nullable",
        "enum",
        "maxItems",
        "minItems",
        "maxProperties",
        "minProperties",
        "maxLength",
        "minLength",
        "pattern",
        "properties",
        "required",
        "items",
        "propertyOrdering",
    }

    result = {}

    for key in allowed_fields:
        if key not in schema:
            continue

        value = schema[key]

        if key == "properties":
            if not isinstance(value, dict):
                continue

            cleaned_properties = {}

            for property_name, property_schema in value.items():
                cleaned_properties[property_name] = (
                    sanitize_vertex_schema(
                        property_schema
                    )
                )

            result["properties"] = cleaned_properties

        elif key == "items":
            result["items"] = sanitize_vertex_schema(
                value
            )

        elif key == "required":
            if isinstance(value, list):
                result["required"] = [
                    item
                    for item in value
                    if isinstance(item, str)
                ]

        elif key == "type":
            if isinstance(value, str):
                value = value.upper()

            valid_types = {
                "STRING",
                "NUMBER",
                "INTEGER",
                "BOOLEAN",
                "ARRAY",
                "OBJECT",
            }

            if value in valid_types:
                result["type"] = value

        else:
            result[key] = value

    # Infer missing object type.
    if (
        "properties" in result
        and "type" not in result
    ):
        result["type"] = "OBJECT"

    # Infer missing array type.
    if (
        "items" in result
        and "type" not in result
    ):
        result["type"] = "ARRAY"

    # Infer missing string type for enums.
    if (
        "enum" in result
        and "type" not in result
    ):
        result["type"] = "STRING"

    # Remove required fields that do not exist.
    if result.get("type") == "OBJECT":
        properties = result.get(
            "properties",
            {},
        )

        required = result.get(
            "required"
        )

        if isinstance(required, list):
            result["required"] = [
                name
                for name in required
                if name in properties
            ]

            if not result["required"]:
                result.pop(
                    "required",
                    None,
                )

    return result


def convert_openai_tools(openai_tools):
    """
    Convert OpenAI tools into Vertex function declarations.
    """

    declarations = []

    for tool in openai_tools or []:
        if not isinstance(tool, dict):
            continue

        if tool.get("type") != "function":
            continue

        function = tool.get(
            "function",
            {},
        )

        if not isinstance(function, dict):
            continue

        name = function.get("name")

        if not name:
            continue

        raw_parameters = function.get(
            "parameters",
            {
                "type": "object",
                "properties": {},
            },
        )

        parameters = sanitize_vertex_schema(
            raw_parameters
        )

        declarations.append(
            {
                "name": name,
                "description": function.get(
                    "description",
                    "",
                ),
                "parameters": parameters,
            }
        )

    if not declarations:
        return []

    return [
        {
            "functionDeclarations": declarations,
        }
    ]


def convert_tool_choice(tool_choice):
    """
    Convert OpenAI tool_choice to Vertex function-calling mode.

    Vertex modes:
    AUTO
    ANY
    NONE
    """

    if tool_choice is None:
        return "AUTO"

    if tool_choice == "auto":
        return "AUTO"

    if tool_choice == "none":
        return "NONE"

    if tool_choice == "required":
        return "ANY"

    if isinstance(tool_choice, dict):
        return "ANY"

    return "AUTO"


def find_tool_name(messages, tool_call_id):
    """
    Find the original function name for an OpenAI tool result.
    """

    for message in reversed(messages):
        if not isinstance(message, dict):
            continue

        if message.get("role") != "assistant":
            continue

        for tool_call in message.get(
            "tool_calls",
            [],
        ):
            if tool_call.get("id") != tool_call_id:
                continue

            function = tool_call.get(
                "function",
                {},
            )

            return function.get(
                "name",
                tool_call_id,
            )

    return tool_call_id


def convert_messages(messages):
    """
    Convert OpenAI messages to Vertex Gemini contents.
    """

    contents = []
    system_parts = []

    for message in messages:
        if not isinstance(message, dict):
            continue

        role = message.get(
            "role",
            "user",
        )

        # System messages become systemInstruction.
        if role == "system":
            text = extract_text(
                message.get("content")
            )

            if text:
                system_parts.append(
                    {
                        "text": text,
                    }
                )

            continue

        # OpenAI tool result.
        if role == "tool":
            tool_call_id = message.get(
                "tool_call_id",
                "",
            )

            function_name = message.get(
                "name"
            )

            if not function_name:
                function_name = find_tool_name(
                    messages,
                    tool_call_id,
                )

            result_text = extract_text(
                message.get("content")
            )

            contents.append(
                {
                    "role": "user",
                    "parts": [
                        {
                            "functionResponse": {
                                "name": function_name,
                                "response": {
                                    "result": result_text,
                                },
                            }
                        }
                    ],
                }
            )

            continue

        # Previous assistant tool calls.
        if (
            role == "assistant"
            and message.get("tool_calls")
        ):
            parts = []

            text = extract_text(
                message.get("content")
            )

            if text:
                parts.append(
                    {
                        "text": text,
                    }
                )

            for tool_call in message.get(
                "tool_calls",
                [],
            ):
                function = tool_call.get(
                    "function",
                    {},
                )

                function_name = function.get(
                    "name",
                    "",
                )

                raw_arguments = function.get(
                    "arguments",
                    "{}",
                )

                try:
                    arguments = json.loads(
                        raw_arguments
                    )
                except (
                    TypeError,
                    json.JSONDecodeError,
                ):
                    arguments = {}

                parts.append(
                    {
                        "functionCall": {
                            "name": function_name,
                            "args": arguments,
                        }
                    }
                )

            contents.append(
                {
                    "role": "model",
                    "parts": parts,
                }
            )

            continue

        # Normal user or assistant message.
        text = extract_text(
            message.get("content")
        )

        if not text:
            continue

        vertex_role = (
            "model"
            if role == "assistant"
            else "user"
        )

        contents.append(
            {
                "role": vertex_role,
                "parts": [
                    {
                        "text": text,
                    }
                ],
            }
        )

    return contents, system_parts


def extract_vertex_text(vertex_response):
    result = []

    for candidate in vertex_response.get(
        "candidates",
        [],
    ):
        content = candidate.get(
            "content",
            {},
        )

        for part in content.get(
            "parts",
            [],
        ):
            text = part.get("text")

            if text:
                result.append(text)

    return "".join(result)


def extract_vertex_function_calls(vertex_response):
    calls = []

    for candidate in vertex_response.get(
        "candidates",
        [],
    ):
        content = candidate.get(
            "content",
            {},
        )

        for part in content.get(
            "parts",
            [],
        ):
            function_call = part.get(
                "functionCall"
            )

            if not function_call:
                continue

            name = function_call.get(
                "name",
                "",
            )

            arguments = function_call.get(
                "args",
                {},
            )

            calls.append(
                {
                    "id": (
                        "call_"
                        + uuid.uuid4().hex[:24]
                    ),
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": json.dumps(
                            arguments,
                            ensure_ascii=False,
                        ),
                    },
                }
            )

    return calls


def convert_finish_reason(reason):
    mapping = {
        "STOP": "stop",
        "MAX_TOKENS": "length",
        "SAFETY": "content_filter",
        "RECITATION": "content_filter",
        "OTHER": "stop",
    }

    return mapping.get(
        reason,
        "stop",
    )


class VertexProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "VertexOpenAIProxy/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(600)

    def add_cors_headers(self):
        self.send_header(
            "Access-Control-Allow-Origin",
            "*",
        )
        self.send_header(
            "Access-Control-Allow-Methods",
            "GET, POST, OPTIONS",
        )
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization, X-Requested-With",
        )

    def do_OPTIONS(self):
        self.send_response(204)
        self.add_cors_headers()
        self.send_header(
            "Content-Length",
            "0",
        )
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path

        if path in ("/", "/health"):
            self.send_json(
                200,
                {
                    "status": "ok",
                    "service": "vertex-openai-proxy",
                },
            )
            return

        if path == "/v1/models":
            models = []

            for model_name in MODEL_MAP:
                models.append(
                    {
                        "id": model_name,
                        "object": "model",
                        "created": timestamp(),
                        "owned_by": "google",
                    }
                )

            self.send_json(
                200,
                {
                    "object": "list",
                    "data": models,
                },
            )
            return

        self.send_json(
            404,
            make_openai_error(
                "Not found",
                "invalid_request_error",
                404,
            ),
        )

    def do_POST(self):
        path = urlparse(self.path).path

        if path not in (
            "/v1/chat/completions",
            "/chat/completions",
        ):
            self.send_json(
                404,
                make_openai_error(
                    "Endpoint not found",
                    "invalid_request_error",
                    404,
                ),
            )
            return

        try:
            content_length_header = self.headers.get(
                "Content-Length"
            )

            if not content_length_header:
                self.send_json(
                    411,
                    make_openai_error(
                        "Content-Length is required",
                        "invalid_request_error",
                        411,
                    ),
                )
                return

            content_length = int(
                content_length_header
            )

            if content_length > 20 * 1024 * 1024:
                self.send_json(
                    413,
                    make_openai_error(
                        "Request body is too large",
                        "invalid_request_error",
                        413,
                    ),
                )
                return

            raw_body = self.rfile.read(
                content_length
            )

            request = json.loads(raw_body)

            if LOG_REQUESTS:
                print(
                    "========== INCOMING REQUEST =========="
                )
                print(
                    json.dumps(
                        request,
                        indent=2,
                        ensure_ascii=False,
                    )
                )
                print(
                    "======================================="
                )

            messages = request.get(
                "messages"
            )

            if not isinstance(
                messages,
                list,
            ) or not messages:
                self.send_json(
                    400,
                    make_openai_error(
                        "`messages` must be a non-empty array",
                        "invalid_request_error",
                        400,
                    ),
                )
                return

            requested_model = request.get(
                "model"
            ) or "openai/o4-mini"

            # The client-facing model name is preserved.
            # The actual request uses a real Vertex model.
            vertex_model = MODEL_MAP.get(
                requested_model,
                DEFAULT_VERTEX_MODEL,
            )

            temperature = request.get(
                "temperature",
                1.0,
            )

            max_tokens = request.get(
                "max_tokens",
                request.get(
                    "max_completion_tokens",
                    4096,
                ),
            )

            try:
                temperature = float(
                    temperature
                )
                max_tokens = int(
                    max_tokens
                )
            except (
                ValueError,
                TypeError,
            ):
                self.send_json(
                    400,
                    make_openai_error(
                        "Invalid temperature or max_tokens",
                        "invalid_request_error",
                        400,
                    ),
                )
                return

            contents, system_parts = convert_messages(
                messages
            )

            if not contents:
                self.send_json(
                    400,
                    make_openai_error(
                        "No usable messages found",
                        "invalid_request_error",
                        400,
                    ),
                )
                return

            payload = {
                "contents": contents,
                "generationConfig": {
                    "temperature": temperature,
                    "maxOutputTokens": max_tokens,
                },
            }

            if system_parts:
                payload["systemInstruction"] = {
                    "parts": system_parts,
                }

            # Convert and sanitize tools.
            vertex_tools = convert_openai_tools(
                request.get("tools", [])
            )

            if vertex_tools:
                payload["tools"] = vertex_tools

                payload["toolConfig"] = {
                    "functionCallingConfig": {
                        "mode": convert_tool_choice(
                            request.get(
                                "tool_choice"
                            )
                        ),
                    }
                }

            if LOG_REQUESTS and vertex_tools:
                print(
                    "========== VERTEX TOOLS =========="
                )
                print(
                    json.dumps(
                        vertex_tools,
                        indent=2,
                        ensure_ascii=False,
                    )
                )
                print(
                    "=================================="
                )

            access_token = get_access_token()

            if not access_token:
                self.send_json(
                    500,
                    make_openai_error(
                        "Unable to obtain Google Cloud access token",
                        "authentication_error",
                        500,
                    ),
                )
                return

            if request.get("stream") is True:
                self.handle_stream(
                    requested_model=requested_model,
                    vertex_model=vertex_model,
                    payload=payload,
                    access_token=access_token,
                )
            else:
                self.handle_non_stream(
                    requested_model=requested_model,
                    vertex_model=vertex_model,
                    payload=payload,
                    access_token=access_token,
                )

        except json.JSONDecodeError as exc:
            self.send_json(
                400,
                make_openai_error(
                    f"Invalid JSON: {exc}",
                    "invalid_request_error",
                    400,
                ),
            )
        except BrokenPipeError:
            print("Client disconnected")
        except ConnectionResetError:
            print("Client reset the connection")
        except Exception as exc:
            print(
                f"Unexpected proxy error: {exc}"
            )

            try:
                self.send_json(
                    500,
                    make_openai_error(
                        str(exc),
                        "server_error",
                        500,
                    ),
                )
            except Exception:
                pass

    def vertex_url(
        self,
        vertex_model,
        streaming=False,
    ):
        operation = (
            "streamGenerateContent"
            if streaming
            else "generateContent"
        )

        url = (
            "https://aiplatform.googleapis.com/v1/"
            f"projects/{PROJECT_ID}/locations/"
            f"{VERTEX_LOCATION}/publishers/google/models/"
            f"{vertex_model}:{operation}"
        )

        if streaming:
            url += "?alt=sse"

        return url

    def handle_non_stream(
        self,
        requested_model,
        vertex_model,
        payload,
        access_token,
    ):
        response = requests.post(
            self.vertex_url(vertex_model),
            headers={
                "Authorization": (
                    f"Bearer {access_token}"
                ),
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            json=payload,
            timeout=(15, 300),
        )

        if not response.ok:
            self.send_vertex_error(response)
            return

        vertex_data = response.json()

        candidates = vertex_data.get(
            "candidates",
            [],
        )

        candidate = (
            candidates[0]
            if candidates
            else {}
        )

        vertex_finish_reason = candidate.get(
            "finishReason",
            "STOP",
        )

        usage = vertex_data.get(
            "usageMetadata",
            {},
        )

        tool_calls = extract_vertex_function_calls(
            vertex_data
        )

        if tool_calls:
            message = {
                "role": "assistant",
                "content": None,
                "tool_calls": tool_calls,
                "refusal": None,
            }

            finish_reason = "tool_calls"
            native_finish_reason = "function_call"
        else:
            message = {
                "role": "assistant",
                "content": extract_vertex_text(
                    vertex_data
                ),
                "refusal": None,
                "reasoning": None,
            }

            finish_reason = convert_finish_reason(
                vertex_finish_reason
            )
            native_finish_reason = "completed"

        result = {
            "id": make_id("gen"),
            "object": "chat.completion",
            "created": timestamp(),
            "model": requested_model,
            "provider": "Google",
            "system_fingerprint": None,
            "service_tier": "default",
            "choices": [
                {
                    "index": 0,
                    "logprobs": None,
                    "finish_reason": finish_reason,
                    "native_finish_reason": (
                        native_finish_reason
                    ),
                    "message": message,
                }
            ],
            "usage": {
                "prompt_tokens": usage.get(
                    "promptTokenCount",
                    0,
                ),
                "completion_tokens": usage.get(
                    "candidatesTokenCount",
                    0,
                ),
                "total_tokens": usage.get(
                    "totalTokenCount",
                    0,
                ),
            },
        }

        self.send_json(
            200,
            result,
        )

    def handle_stream(
        self,
        requested_model,
        vertex_model,
        payload,
        access_token,
    ):
        response = requests.post(
            self.vertex_url(
                vertex_model,
                streaming=True,
            ),
            headers={
                "Authorization": (
                    f"Bearer {access_token}"
                ),
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
            },
            json=payload,
            stream=True,
            timeout=(15, 600),
        )

        if not response.ok:
            self.send_vertex_error(response)
            return

        completion_id = make_id("gen")
        created = timestamp()
        usage = None
        final_reason = "stop"
        tool_index = 0

        self.send_response(200)
        self.send_header(
            "Content-Type",
            "text/event-stream",
        )
        self.send_header(
            "Cache-Control",
            "no-cache",
        )
        self.send_header(
            "Connection",
            "close",
        )
        self.add_cors_headers()
        self.end_headers()

        self.close_connection = True

        def send_sse(data):
            output = (
                "data: "
                + json.dumps(
                    data,
                    ensure_ascii=False,
                )
                + "\n\n"
            )

            self.wfile.write(
                output.encode("utf-8")
            )
            self.wfile.flush()

        # Initial OpenAI-compatible assistant chunk.
        send_sse(
            {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": requested_model,
                "provider": "Google",
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "role": "assistant",
                            "content": "",
                            "reasoning": None,
                        },
                        "finish_reason": None,
                        "native_finish_reason": None,
                    }
                ],
            }
        )

        try:
            for raw_line in response.iter_lines(
                decode_unicode=True
            ):
                if not raw_line:
                    continue

                line = raw_line.strip()

                if line.startswith("data:"):
                    line = line[5:].strip()

                if line == "[DONE]":
                    break

                try:
                    vertex_chunk = json.loads(
                        line
                    )
                except json.JSONDecodeError:
                    continue

                if vertex_chunk.get(
                    "usageMetadata"
                ):
                    usage = vertex_chunk[
                        "usageMetadata"
                    ]

                candidates = vertex_chunk.get(
                    "candidates",
                    [],
                )

                for candidate in candidates:
                    candidate_finish = candidate.get(
                        "finishReason"
                    )

                    if candidate_finish:
                        final_reason = convert_finish_reason(
                            candidate_finish
                        )

                    content = candidate.get(
                        "content",
                        {},
                    )

                    for part in content.get(
                        "parts",
                        [],
                    ):
                        text = part.get("text")

                        if text:
                            send_sse(
                                {
                                    "id": completion_id,
                                    "object": (
                                        "chat.completion.chunk"
                                    ),
                                    "created": created,
                                    "model": requested_model,
                                    "provider": "Google",
                                    "choices": [
                                        {
                                            "index": 0,
                                            "delta": {
                                                "role": (
                                                    "assistant"
                                                ),
                                                "content": text,
                                            },
                                            "finish_reason": None,
                                            "native_finish_reason": None,
                                        }
                                    ],
                                }
                            )

                        function_call = part.get(
                            "functionCall"
                        )

                        if function_call:
                            function_name = function_call.get(
                                "name",
                                "",
                            )

                            arguments = function_call.get(
                                "args",
                                {},
                            )

                            argument_text = json.dumps(
                                arguments,
                                ensure_ascii=False,
                                separators=(",", ":"),
                            )

                            tool_call_id = (
                                "call_"
                                + uuid.uuid4().hex[:24]
                            )

                            send_sse(
                                {
                                    "id": completion_id,
                                    "object": (
                                        "chat.completion.chunk"
                                    ),
                                    "created": created,
                                    "model": requested_model,
                                    "provider": "Google",
                                    "choices": [
                                        {
                                            "index": 0,
                                            "delta": {
                                                "tool_calls": [
                                                    {
                                                        "index": tool_index,
                                                        "id": tool_call_id,
                                                        "type": "function",
                                                        "function": {
                                                            "name": function_name,
                                                            "arguments": (
                                                                argument_text
                                                            ),
                                                        },
                                                    }
                                                ]
                                            },
                                            "finish_reason": None,
                                            "native_finish_reason": None,
                                        }
                                    ],
                                }
                            )

                            tool_index += 1
                            final_reason = "tool_calls"

            final_chunk = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": requested_model,
                "provider": "Google",
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "role": "assistant",
                            "content": "",
                        },
                        "finish_reason": final_reason,
                        "native_finish_reason": (
                            "function_call"
                            if final_reason == "tool_calls"
                            else "completed"
                        ),
                    }
                ],
            }

            if usage:
                final_chunk["usage"] = {
                    "prompt_tokens": usage.get(
                        "promptTokenCount",
                        0,
                    ),
                    "completion_tokens": usage.get(
                        "candidatesTokenCount",
                        0,
                    ),
                    "total_tokens": usage.get(
                        "totalTokenCount",
                        0,
                    ),
                }

            send_sse(final_chunk)

            self.wfile.write(
                b"data: [DONE]\n\n"
            )
            self.wfile.flush()

        except BrokenPipeError:
            print("Streaming client disconnected")
        except ConnectionResetError:
            print("Streaming client reset the connection")
        finally:
            response.close()

    def send_vertex_error(self, response):
        try:
            data = response.json()

            message = data.get(
                "error",
                {},
            ).get(
                "message",
                response.text,
            )
        except Exception:
            message = (
                response.text
                or "Vertex AI request failed"
            )

        status = response.status_code

        if status in (401, 403):
            error_type = "authentication_error"
        elif status == 429:
            error_type = "rate_limit_error"
        elif 400 <= status < 500:
            error_type = "invalid_request_error"
        else:
            error_type = "server_error"

        self.send_json(
            status,
            make_openai_error(
                message,
                error_type,
                status,
            ),
        )

    def send_json(self, status, data):
        body = json.dumps(
            data,
            ensure_ascii=False,
        ).encode("utf-8")

        self.send_response(status)
        self.send_header(
            "Content-Type",
            "application/json",
        )
        self.send_header(
            "Content-Length",
            str(len(body)),
        )
        self.send_header(
            "Connection",
            "close",
        )
        self.add_cors_headers()
        self.end_headers()

        self.wfile.write(body)
        self.wfile.flush()

    def log_message(self, format_string, *args):
        print(
            f"[HTTP] {format_string % args}"
        )


def main():
    server = ThreadingHTTPServer(
        ("0.0.0.0", PORT),
        VertexProxyHandler,
    )

    print("========================================")
    print(" Vertex AI OpenAI-Compatible Proxy")
    print("========================================")
    print(f"Port: {PORT}")
    print(f"Project: {PROJECT_ID}")
    print(f"Vertex location: {VERTEX_LOCATION}")
    print(f"Default Vertex model: {DEFAULT_VERTEX_MODEL}")
    print("Chat endpoint: /v1/chat/completions")
    print("Models endpoint: /v1/models")
    print("Health endpoint: /health")
    print("========================================")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopping server...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
