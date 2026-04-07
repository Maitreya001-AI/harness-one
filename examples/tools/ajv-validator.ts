// Install: npm install ajv ajv-formats
//
// This example shows how to implement harness-one's SchemaValidator interface
// using Ajv, and inject it into createRegistry(). The built-in validator
// handles basic schemas; Ajv adds support for $ref, oneOf, anyOf, formats, etc.

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { JsonSchema } from 'harness-one/core';
import type { SchemaValidator, ValidationError, ToolDefinition, ToolResult } from 'harness-one/tools';
import { createRegistry, toolSuccess } from 'harness-one/tools';

// ---------------------------------------------------------------------------
// SchemaValidator implementation using Ajv
// ---------------------------------------------------------------------------

/**
 * Create a SchemaValidator backed by Ajv, supporting full JSON Schema draft-07+.
 *
 * harness-one's SchemaValidator interface requires:
 *   validate(schema: JsonSchema, params: unknown): { valid: boolean; errors: ValidationError[] }
 *
 * This replaces the built-in lightweight validator when you need:
 * - $ref / $defs for schema composition
 * - oneOf / anyOf / allOf combinators
 * - String formats (email, uri, date-time, etc.)
 * - Custom keywords and vocabularies
 *
 * Usage:
 *   const validator = createAjvValidator();
 *   const registry = createRegistry({ validator });
 */
export function createAjvValidator(config?: {
  allErrors?: boolean;
  formats?: boolean;
}): SchemaValidator {
  const ajv = new Ajv({
    allErrors: config?.allErrors ?? true,
    strict: false, // Allow extra keywords from harness-one's JsonSchema
  });

  // Add format validators (email, uri, date-time, uuid, etc.)
  if (config?.formats !== false) {
    addFormats(ajv);
  }

  return {
    validate(schema: JsonSchema, params: unknown): { valid: boolean; errors: ValidationError[] } {
      const valid = ajv.validate(schema, params);

      if (valid) {
        return { valid: true, errors: [] };
      }

      // Map Ajv errors to harness-one's ValidationError format
      const errors: ValidationError[] = (ajv.errors ?? []).map((err) => ({
        path: err.instancePath || '(root)',
        message: err.message ?? 'Validation failed',
        suggestion: formatSuggestion(err),
      }));

      return { valid: false, errors };
    },
  };
}

/** Generate a human-readable suggestion from an Ajv error. */
function formatSuggestion(err: {
  keyword: string;
  params: Record<string, unknown>;
  instancePath: string;
}): string {
  switch (err.keyword) {
    case 'required':
      return `Add the required property "${err.params.missingProperty}"`;
    case 'type':
      return `Change the value at ${err.instancePath || 'root'} to type "${err.params.type}"`;
    case 'enum':
      return `Use one of the allowed values: ${JSON.stringify(err.params.allowedValues)}`;
    case 'format':
      return `Provide a valid ${err.params.format} string`;
    case 'oneOf':
      return 'Value must match exactly one of the specified schemas';
    case 'anyOf':
      return 'Value must match at least one of the specified schemas';
    default:
      return `Fix the ${err.keyword} constraint at ${err.instancePath || 'root'}`;
  }
}

// ---------------------------------------------------------------------------
// Example: inject Ajv into createRegistry
// ---------------------------------------------------------------------------

async function demo() {
  // 1. Create the Ajv-based validator (implements SchemaValidator)
  const validator = createAjvValidator();

  // 2. Inject into harness-one's tool registry
  //    All tool parameter validation now goes through Ajv instead of the
  //    built-in lightweight validator.
  const registry = createRegistry({ validator });

  // 3. Register a tool with a complex schema using oneOf + format
  const complexTool: ToolDefinition = {
    name: 'manage_entity',
    description: 'Create or update a user or resource',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'delete'],
          description: 'The action to perform',
        },
        target: {
          // oneOf: target is either a user or a resource
          oneOf: [
            {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['user'] },
                email: { type: 'string', format: 'email' },
                name: { type: 'string' },
              },
              required: ['type', 'email', 'name'],
            },
            {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['resource'] },
                uri: { type: 'string', format: 'uri' },
              },
              required: ['type', 'uri'],
            },
          ],
        },
      },
      required: ['action', 'target'],
    },
    async execute(params: unknown): Promise<ToolResult> {
      return toolSuccess({ managed: params });
    },
  };

  registry.register(complexTool);

  // 4. Execute with valid input — Ajv validates the oneOf + format constraints
  const validResult = await registry.execute({
    id: 'call-1',
    name: 'manage_entity',
    arguments: JSON.stringify({
      action: 'create',
      target: { type: 'user', email: 'alice@example.com', name: 'Alice' },
    }),
  });
  console.log('Valid call result:', validResult);

  // 5. Execute with invalid input — bad email format caught by Ajv
  const invalidResult = await registry.execute({
    id: 'call-2',
    name: 'manage_entity',
    arguments: JSON.stringify({
      action: 'create',
      target: { type: 'user', email: 'not-an-email', name: 'Bob' },
    }),
  });
  console.log('Invalid call result:', invalidResult);

  // 6. Direct validation (useful outside of tool registry)
  const directCheck = validator.validate(
    {
      type: 'object',
      properties: { date: { type: 'string', format: 'date-time' } },
      required: ['date'],
    },
    { date: '2025-01-15T10:30:00Z' },
  );
  console.log('Direct validation:', directCheck);
}

demo().catch(console.error);
