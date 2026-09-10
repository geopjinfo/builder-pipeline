'use strict';
/**
 * Contract-oracle adapter for OpenAPI 3.x documents (JSON). Compiles a document into the operation list
 * `scripts/lib/contract-oracle.cjs` judges served traffic against.
 *
 * THE ADAPTER INTERFACE. An adapter exports `compileOperations(doc, config)` returning operations of shape
 *
 *   { method: 'GET', template: '/items/{id}', re: RegExp, literal: number,
 *     statuses: Set<string>,          declared response keys: '200', '4XX', 'default'
 *     query: Set<string>,             declared query parameter names
 *     openQuery: boolean,             true when a free-form query object makes undeclared keys legitimate
 *     deepQuery: Set<string>,         deepObject parameter names (`filter[x]` belongs to `filter`)
 *     codes: Map<string, Set<string>> error codes declared per status key }
 *
 * sorted MOST SPECIFIC FIRST, so a literal path (`/items/new`) wins over a template (`/items/{id}`). Any
 * other contract format (a gRPC transcoding table, a hand-written route list) fits by producing that shape.
 *
 * What it reads: path-level and operation-level parameters (an operation parameter overrides a path-level
 * one of the same name and location), `$ref` to local components, and per-status error codes from
 * `content.*.example[codeField]`, `content.*.examples.*.value[codeField]` and a schema's
 * `properties[codeField].enum` / `const`. YAML documents must be converted to JSON first (no parser
 * dependency ships with the pack).
 */

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

function resolveRef(doc, node, depth = 0) {
  if (!node || typeof node !== 'object' || typeof node.$ref !== 'string' || depth > 20) return node;
  if (!node.$ref.startsWith('#/')) return null; // external references are not followed
  const target = node.$ref
    .slice(2)
    .split('/')
    .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((n, key) => (n && typeof n === 'object' ? n[key] : undefined), doc);
  return resolveRef(doc, target, depth + 1) ?? null;
}

function codesOf(doc, response, codeField) {
  const set = new Set();
  const r = resolveRef(doc, response);
  for (const media of Object.values(r?.content ?? {})) {
    const example = resolveRef(doc, media?.example);
    if (example && typeof example[codeField] === 'string') set.add(example[codeField]);
    for (const ex of Object.values(media?.examples ?? {})) {
      const value = resolveRef(doc, ex)?.value;
      if (value && typeof value[codeField] === 'string') set.add(value[codeField]);
    }
    const prop = resolveRef(doc, resolveRef(doc, media?.schema)?.properties?.[codeField]);
    for (const v of prop?.enum ?? []) if (typeof v === 'string') set.add(v);
    if (typeof prop?.const === 'string') set.add(prop.const);
  }
  return set;
}

function templateRegex(template) {
  const pattern = template
    .split(/(\{[^}]+\})/)
    .map((part) => (/^\{[^}]+\}$/.test(part) ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${pattern}/?$`);
}

/**
 * @param {object} doc  a parsed OpenAPI 3.x document
 * @param {{ codeField?: string }} [config]
 */
function compileOperations(doc, { codeField = 'code' } = {}) {
  if (!doc || typeof doc !== 'object' || typeof doc.openapi !== 'string' || !doc.openapi.startsWith('3.')) {
    throw new Error('openapi3 adapter: not an OpenAPI 3.x document (missing "openapi": "3.x")');
  }
  const ops = [];
  for (const [template, rawItem] of Object.entries(doc.paths ?? {})) {
    const item = resolveRef(doc, rawItem) ?? {};
    const pathParams = (item.parameters ?? []).map((p) => resolveRef(doc, p)).filter(Boolean);
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const params = new Map();
      for (const p of [...pathParams, ...(op.parameters ?? []).map((x) => resolveRef(doc, x)).filter(Boolean)]) params.set(`${p.in}:${p.name}`, p);
      const queryParams = [...params.values()].filter((p) => p.in === 'query');
      const codes = new Map();
      for (const [status, response] of Object.entries(op.responses ?? {})) codes.set(String(status).toUpperCase(), codesOf(doc, response, codeField));
      ops.push({
        method: method.toUpperCase(),
        template,
        re: templateRegex(template),
        literal: template.replace(/\{[^}]+\}/g, '').length,
        statuses: new Set(Object.keys(op.responses ?? {}).map((s) => String(s).toUpperCase())),
        query: new Set(queryParams.map((p) => p.name)),
        deepQuery: new Set(queryParams.filter((p) => p.style === 'deepObject').map((p) => p.name)),
        // `style: form, explode: true` (the default) on an object schema spreads its keys into the query.
        openQuery: queryParams.some((p) => {
          const schema = resolveRef(doc, p.schema);
          const form = (p.style ?? 'form') === 'form' && p.explode !== false;
          return form && (schema?.type === 'object' || schema?.additionalProperties !== undefined);
        }),
        codes,
      });
    }
  }
  return ops.sort((a, b) => b.literal - a.literal || a.template.localeCompare(b.template));
}

module.exports = { name: 'openapi3', compileOperations, resolveRef };
