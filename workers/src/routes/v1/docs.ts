/**
 * /v1/docs — OpenAPI 文档页面
 * /v1/openapi.json — OpenAPI 规范 JSON
 *
 * 提供交互式 API 文档，基于 ReDoc
 */

import { Hono } from 'hono';
import type { Env } from '../../types';

export const docsRoute = new Hono<{ Bindings: Env }>();

// OpenAPI 规范 JSON
docsRoute.get('/v1/openapi.json', (c) => {
  const baseUrl = new URL(c.req.url);
  const serverUrl = `${baseUrl.protocol}//${baseUrl.host}`;

  const openapi = {
    openapi: '3.1.0',
    info: {
      title: 'freellmapi-cf API',
      description: 'Unified LLM API Router on Cloudflare Workers. 聚合多个 LLM 服务商到单个 OpenAI 兼容 API。',
      version: '3.6.0',
      contact: {
        name: 'freellmapi-cf',
        url: 'https://github.com/827802685/freellmapi-cf',
      },
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT',
      },
    },
    servers: [
      {
        url: `${serverUrl}/v1`,
        description: 'Current server',
      },
    ],
    tags: [
      {
        name: 'OpenAI Compatible',
        description: 'OpenAI 兼容 API，可直接用 OpenAI SDK',
      },
      {
        name: 'Anthropic Compatible',
        description: 'Anthropic Messages API 兼容',
      },
      {
        name: 'OpenAI Responses',
        description: 'OpenAI Responses API 兼容 (Codex CLI)',
      },
    ],
    paths: {
      '/chat/completions': {
        post: {
          tags: ['OpenAI Compatible'],
          summary: 'Chat completions',
          description: 'OpenAI 兼容 chat completions 端点，支持流式和非流式',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['model', 'messages'],
                  properties: {
                    model: {
                      type: 'string',
                      description: 'Model ID (platform:model or just model name)',
                      example: 'groq:llama-3.3-70b-versatile',
                    },
                    messages: {
                      type: 'array',
                      description: 'Chat messages',
                      items: {
                        type: 'object',
                        properties: {
                          role: {
                            type: 'string',
                            enum: ['system', 'user', 'assistant', 'tool'],
                          },
                          content: {
                            oneOf: [
                              { type: 'string' },
                              {
                                type: 'array',
                                items: {
                                  type: 'object',
                                  properties: {
                                    type: { type: 'string', enum: ['text', 'image_url'] },
                                    text: { type: 'string' },
                                    image_url: {
                                      type: 'object',
                                      properties: { url: { type: 'string' } },
                                    },
                                  },
                                },
                              },
                            ],
                          },
                          tool_calls: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                id: { type: 'string' },
                                type: { type: 'string' },
                                function: {
                                  type: 'object',
                                  properties: {
                                    name: { type: 'string' },
                                    arguments: { type: 'string' },
                                  },
                                },
                              },
                            },
                          },
                          tool_call_id: { type: 'string' },
                        },
                      },
                    },
                    stream: {
                      type: 'boolean',
                      description: 'Enable streaming',
                      default: false,
                    },
                    max_tokens: {
                      type: 'integer',
                      description: 'Maximum completion tokens',
                    },
                    temperature: {
                      type: 'number',
                      minimum: 0,
                      maximum: 2,
                    },
                    top_p: { type: 'number' },
                    top_k: { type: 'integer' },
                    stop: {
                      oneOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' } },
                      ],
                    },
                    presence_penalty: { type: 'number' },
                    frequency_penalty: { type: 'number' },
                    tools: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          type: { type: 'string', enum: ['function'] },
                          function: {
                            type: 'object',
                            properties: {
                              name: { type: 'string' },
                              description: { type: 'string' },
                              parameters: { type: 'object' },
                            },
                          },
                        },
                      },
                    },
                    tool_choice: {
                      oneOf: [
                        { type: 'string', enum: ['none', 'auto', 'required'] },
                        {
                          type: 'object',
                          properties: {
                            type: { type: 'string' },
                            function: {
                              type: 'object',
                              properties: { name: { type: 'string' } },
                            },
                          },
                        },
                      ],
                    },
                    response_format: {
                      type: 'object',
                      properties: {
                        type: { type: 'string', enum: ['text', 'json_object'] },
                      },
                    },
                    seed: { type: 'integer' },
                    reasoning_effort: {
                      type: 'string',
                      enum: ['minimal', 'low', 'medium', 'high', 'auto'],
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Successful completion',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      object: { type: 'string', example: 'chat.completion' },
                      created: { type: 'integer' },
                      model: { type: 'string' },
                      choices: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            index: { type: 'integer' },
                            message: {
                              type: 'object',
                              properties: {
                                role: { type: 'string' },
                                content: { type: 'string' },
                                reasoning_content: { type: 'string' },
                                tool_calls: {
                                  type: 'array',
                                  items: {
                                    type: 'object',
                                    properties: {
                                      id: { type: 'string' },
                                      type: { type: 'string' },
                                      function: {
                                        type: 'object',
                                        properties: {
                                          name: { type: 'string' },
                                          arguments: { type: 'string' },
                                        },
                                      },
                                    },
                                  },
                                },
                              },
                            },
                            finish_reason: { type: 'string' },
                          },
                        },
                      },
                      usage: {
                        type: 'object',
                        properties: {
                          prompt_tokens: { type: 'integer' },
                          completion_tokens: { type: 'integer' },
                          total_tokens: { type: 'integer' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/models': {
      get: {
        tags: ['OpenAI Compatible'],
        summary: 'List all models',
        description: 'List all enabled models with metadata',
        responses: {
          '200': {
            description: 'List of models',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    object: { type: 'string', example: 'list' },
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          object: { type: 'string', example: 'model' },
                          created: { type: 'integer' },
                          owned_by: { type: 'string' },
                          display_name: { type: 'string' },
                          family: { type: 'string' },
                          context_window: { type: 'integer' },
                          supports_tools: { type: 'boolean' },
                          supports_vision: { type: 'boolean' },
                          free_tier: {
                            type: 'object',
                            properties: {
                              rpm: { type: ['integer', 'null'] },
                              rpd: { type: ['integer', 'null'] },
                              tpm: { type: ['integer', 'null'] },
                              tpd: { type: ['integer', 'null'] },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/completions': {
      post: {
        tags: ['OpenAI Compatible'],
        summary: 'Legacy text completions',
        description: 'Legacy completions endpoint for Continue.dev and older clients',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['model', 'prompt'],
                properties: {
                  model: { type: 'string' },
                  prompt: {
                    oneOf: [
                      { type: 'string' },
                      { type: 'array', items: { type: 'string' } },
                    ],
                  },
                  suffix: { type: 'string' },
                  max_tokens: { type: 'integer' },
                  temperature: { type: 'number' },
                  top_p: { type: 'number' },
                  n: { type: 'integer' },
                  stream: { type: 'boolean' },
                  logprobs: { type: 'integer' },
                  stop: {
                    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
                  },
                  presence_penalty: { type: 'number' },
                  frequency_penalty: { type: 'number' },
                  seed: { type: 'integer' },
                },
              },
            },
          },
        },
      },
    },
    '/embeddings': {
      post: {
        tags: ['OpenAI Compatible'],
        summary: 'Create embeddings',
        description: 'Generate vector embeddings for input text',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['model', 'input'],
                properties: {
                  model: { type: 'string' },
                  input: {
                    oneOf: [
                      { type: 'string' },
                      { type: 'array', items: { type: 'string' } },
                    ],
                  },
                  encoding_format: {
                    type: 'string',
                    enum: ['float', 'base64'],
                  },
                  user: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    '/images/generations': {
      post: {
        tags: ['OpenAI Compatible'],
        summary: 'Image generation',
        description: 'Generate images from text prompt',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['prompt'],
                properties: {
                  model: { type: 'string' },
                  prompt: { type: 'string' },
                  n: { type: 'integer' },
                  size: { type: 'string' },
                  quality: { type: 'string' },
                  style: { type: 'string' },
                  response_format: { type: 'string', enum: ['url', 'b64_json'] },
                },
              },
            },
          },
        },
      },
    },
    '/audio/speech': {
      post: {
        tags: ['OpenAI Compatible'],
        summary: 'Text to speech',
        description: 'Convert text to speech',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['model', 'input', 'voice'],
                properties: {
                  model: { type: 'string' },
                  input: { type: 'string' },
                  voice: { type: 'string' },
                  speed: { type: 'number' },
                  response_format: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    '/messages': {
      post: {
        tags: ['Anthropic Compatible'],
        summary: 'Anthropic Messages API',
        description: 'Anthropic Messages API compatible endpoint for Claude Code',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['model', 'messages'],
                properties: {
                  model: { type: 'string' },
                  system: {
                    oneOf: [{ type: 'string' }, { type: 'array' }],
                  },
                  messages: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        role: { type: 'string', enum: ['user', 'assistant'] },
                        content: {
                          oneOf: [{ type: 'string' }, { type: 'array' }],
                        },
                      },
                    },
                  },
                  max_tokens: { type: 'integer' },
                  temperature: { type: 'number' },
                  top_p: { type: 'number' },
                  stop_sequences: { type: 'array', items: { type: 'string' } },
                  stream: { type: 'boolean' },
                  tools: { type: 'array' },
                  tool_choice: {},
                },
              },
            },
          },
        },
      },
    },
    '/responses': {
      post: {
        tags: ['OpenAI Responses'],
        summary: 'OpenAI Responses API',
        description: 'OpenAI Responses API compatible endpoint for Codex CLI',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['model', 'input'],
                properties: {
                  model: { type: 'string' },
                  input: {
                    oneOf: [{ type: 'string' }, { type: 'array' }],
                  },
                  instructions: { type: 'string' },
                  stream: { type: 'boolean' },
                  temperature: { type: 'number' },
                  top_p: { type: 'number' },
                  max_output_tokens: { type: 'integer' },
                  tools: { type: 'array' },
                  tool_choice: {},
                  previous_response_id: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Bearer token (freellmapi-xxx)',
        },
      },
    },
    security: [
      { BearerAuth: [] },
    ],
  };

  return c.json(openapi);
});

// ReDoc 文档页面
docsRoute.get('/v1/docs', (c) => {
  const baseUrl = new URL(c.req.url);
  const openapiUrl = `${baseUrl.protocol}//${baseUrl.host}/v1/openapi.json`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>freellmapi-cf API Documentation</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body { margin: 0; padding: 0; background: #f8fafc; }
    #redoc-container { width: 100%; min-height: 100vh; }
  </style>
</head>
<body>
  <div id="redoc-container"></div>
  <script src="https://cdn.jsdelivr.net/npm/redoc@next/bundles/redoc.standalone.js"></script>
  <script>
    Redoc.init('${openapiUrl}', {
      "expandResponses": "200,201",
      "expandDefault": 1,
      "hideDownload": false,
      "showExtensions": true,
      "render": {
        "theme": {
          "colors": {
            "primary": {
              "main": "#7c3aed"
            }
          }
        }
      }
    }, document.getElementById('redoc-container'));
  </script>
</body>
</html>`;

  return c.html(html);
});

// 404 for GET /v1/docs/
docsRoute.get('/v1/docs/*', (c) => c.redirect('/v1/docs'));
