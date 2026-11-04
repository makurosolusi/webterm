// JSON Schema subset used by capability input/output schemas. Plain data, so the same object
// projects to MCP `tools/list`, OpenAPI and `cap.describe` without conversion.
// ponytail: hand-rolled subset (type/properties/required/enum/items/min/max/pattern/anyOf); no
// `$ref`, `oneOf`, formats or `additionalProperties`. Swap for ajv if a projection needs full draft 2020-12.

export type JsonType = 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'null'

export interface JsonSchema {
  type?: JsonType | readonly JsonType[]
  description?: string
  properties?: Readonly<Record<string, JsonSchema>>
  required?: readonly string[]
  items?: JsonSchema
  enum?: readonly (string | number | boolean | null)[]
  const?: string | number | boolean | null
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  maxItems?: number
  pattern?: string
  anyOf?: readonly JsonSchema[]
}

function typeOf(value: unknown): JsonType {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value as JsonType
}

function typeMatches(want: JsonType, got: JsonType): boolean {
  return want === got || (want === 'number' && got === 'integer')
}

/** First violation of `schema` by `value` as `"<path>: <rule>"`, or null when it conforms. */
export function checkSchema(schema: JsonSchema, value: unknown, path = '$'): string | null {
  if (schema.anyOf) return schema.anyOf.some((s) => checkSchema(s, value, path) === null) ? null : `${path}: anyOf`
  const got = typeOf(value)
  if (schema.type) {
    const wants = typeof schema.type === 'string' ? [schema.type] : schema.type
    if (!wants.some((w) => typeMatches(w, got))) return `${path}: type ${wants.join('|')}`
  }
  if (schema.const !== undefined && value !== schema.const) return `${path}: const`
  if (schema.enum && !schema.enum.includes(value as never)) return `${path}: enum`
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${path}: minLength`
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path}: maxLength`
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) return `${path}: pattern`
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path}: minimum`
    if (schema.maximum !== undefined && value > schema.maximum) return `${path}: maximum`
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path}: maxItems`
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const err = checkSchema(schema.items, value[i], `${path}[${i}]`)
        if (err) return err
      }
    }
  }
  if (got === 'object') {
    const obj = value as Record<string, unknown>
    for (const key of schema.required ?? []) if (obj[key] === undefined) return `${path}.${key}: required`
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (obj[key] === undefined) continue
      const err = checkSchema(sub, obj[key], `${path}.${key}`)
      if (err) return err
    }
  }
  return null
}

/** True for a schema whose top level is a plain object (what every capability input/output must be). */
export function isObjectSchema(schema: JsonSchema | undefined): boolean {
  return !!schema && schema.type === 'object'
}

/** Builds an object schema; `required` lists the mandatory keys. */
export function obj(properties: Record<string, JsonSchema>, required: readonly string[] = []): JsonSchema {
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

/** Common leaf schemas. */
export const S = {
  str: (maxLength?: number, extra: JsonSchema = {}): JsonSchema => ({ type: 'string', ...(maxLength ? { maxLength } : {}), ...extra }),
  int: (minimum?: number, maximum?: number): JsonSchema => ({ type: 'integer', ...(minimum !== undefined ? { minimum } : {}), ...(maximum !== undefined ? { maximum } : {}) }),
  bool: (): JsonSchema => ({ type: 'boolean' }),
  oneOf: (...values: string[]): JsonSchema => ({ type: 'string', enum: values }),
  arr: (items: JsonSchema, maxItems?: number): JsonSchema => ({ type: 'array', items, ...(maxItems ? { maxItems } : {}) }),
  anyObj: (description?: string): JsonSchema => ({ type: 'object', ...(description ? { description } : {}) }),
  /** Object listing its keys with values of any type (result shapes whose leaves are documented elsewhere). */
  keys: (...names: string[]): JsonSchema => ({ type: 'object', properties: Object.fromEntries(names.map((n) => [n, {}])) }),
  any: (): JsonSchema => ({}),
} as const
