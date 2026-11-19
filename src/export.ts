import { isMap, parseDocument, stringify, type Document } from 'yaml';
import type { Analysis, ApiSpec, BodyTemplate, Declaration, InversePlan, RequestTemplate, ValueRef } from './types.js';

/** The x-undogen declaration that reproduces a compiled plan, or undefined if there is nothing to declare. */
export function toDeclaration(plan: InversePlan): Declaration | undefined {
  if (plan.reversibility === 'unknown') return undefined;
  const reason = plan.reasons[0];
  if (plan.reversibility === 'irreversible') {
    return { reversibility: 'irreversible', strategy: plan.strategy, confidence: plan.confidence, reason };
  }
  if (!plan.inverse) return { reversibility: plan.reversibility, strategy: plan.strategy, reason };
  const bindings: Record<string, string> = {};
  for (const [name, ref] of Object.entries(plan.inverse.bindings)) {
    if (ref.from === 'params' && ref.key === name) continue; // the default
    bindings[name] = ref.from === 'location' ? 'location' : `${ref.from}.${ref.key}`;
  }
  const decl: Declaration = {
    reversibility: plan.reversibility,
    strategy: plan.strategy,
    confidence: plan.confidence,
    inverse: plan.inverse.operationId,
  };
  if (plan.inverseIfMissing) decl.inverseIfMissing = plan.inverseIfMissing.operationId;
  if (Object.keys(bindings).length) decl.bindings = bindings;
  const body = declaredBody(plan.inverse.body);
  if (body !== undefined) decl.body = body;
  if (reason) decl.reason = reason;
  return decl;
}

function declaredBody(body: BodyTemplate | undefined): Declaration['body'] | undefined {
  switch (body?.from) {
    case 'before':
      return 'before';
    case 'before-request-keys':
      return 'before-request-keys';
    case 'request':
      return 'request';
    case 'literal':
      return { literal: body.value };
    default:
      return undefined;
  }
}

/** An OpenAPI runtime expression for a binding, when one exists (OpenAPI links cannot read captured state). */
function linkExpression(ref: ValueRef): string | undefined {
  switch (ref.from) {
    case 'params':
      return `$request.path.${ref.key}`;
    case 'query':
      return `$request.query.${ref.key}`;
    case 'request':
      return `$request.body#/${ref.key.replace(/\./g, '/')}`;
    case 'response':
      return `$response.body#/${ref.key.replace(/\./g, '/')}`;
    default:
      return undefined;
  }
}

/** An OpenAPI 3 Link to the inverse, if the inverse can be expressed as one. */
export function toLink(plan: InversePlan): Record<string, unknown> | undefined {
  const inv = plan.inverse;
  if (!inv || plan.capture || inv.body?.from === 'before' || inv.body?.from === 'before-request-keys') return undefined;
  const parameters: Record<string, string> = {};
  for (const [name, ref] of [...Object.entries(inv.bindings), ...Object.entries(inv.query ?? {})]) {
    const expr = linkExpression(ref);
    if (!expr) return undefined;
    parameters[name] = expr;
  }
  const link: Record<string, unknown> = { operationId: inv.operationId, description: `Undo (${plan.reversibility}, ${plan.strategy})` };
  if (Object.keys(parameters).length) link.parameters = parameters;
  if (inv.body?.from === 'literal') link.requestBody = inv.body.value;
  if (inv.body?.from === 'request') link.requestBody = '$request.body';
  return link;
}

export interface AnnotateOptions {
  /** Also add OpenAPI `links` named "undo" to success responses (OpenAPI 3 only). Default true. */
  links?: boolean;
  /** Replace x-undogen declarations that are already present. Default false: what you wrote wins. */
  overwrite?: boolean;
}

/**
 * Write the compiled plans back into the spec as x-undogen declarations (and
 * OpenAPI links), keeping the document's formatting and comments. The result
 * analyzes to the same plans, so API owners can ship reviewed declarations.
 */
export function annotate(source: string, analysis: Analysis, options: AnnotateOptions = {}): string {
  const isJson = source.trimStart().startsWith('{');
  const doc: Document = parseDocument(source, { keepSourceTokens: true });
  const oas3 = typeof doc.get('openapi') === 'string';
  for (const plan of analysis.plans) {
    const opNode = doc.getIn(['paths', plan.path, plan.method]);
    if (!isMap(opNode)) continue; // the operation lives in an external file
    const decl = toDeclaration(plan);
    if (decl && (options.overwrite || !opNode.has('x-undogen'))) opNode.set('x-undogen', doc.createNode(decl));
    if (options.links === false || !oas3) continue;
    const link = toLink(plan);
    const responses = opNode.get('responses');
    if (!link || !isMap(responses)) continue;
    const code = responses.items.map((i) => String((i.key as { value?: unknown })?.value ?? i.key)).filter((c) => /^2/.test(c)).sort()[0];
    const response = code ? responses.get(code) ?? responses.get(Number(code)) : undefined;
    if (!isMap(response)) continue;
    if (!response.has('links')) response.set('links', doc.createNode({}));
    const links = response.get('links');
    if (isMap(links) && (options.overwrite || !links.has('undo'))) links.set('undo', doc.createNode(link));
  }
  return isJson ? JSON.stringify(doc.toJS(), null, 2) + '\n' : doc.toString();
}

/**
 * An Arazzo 1.0 document with one workflow per undoable operation: capture
 * the prior state (if needed), run the operation, run its inverse. Workflow
 * engines and docs tools that speak Arazzo can then show or execute the undo.
 */
export function toArazzo(spec: ApiSpec, analysis: Analysis, sourceUrl: string): string {
  const opById = new Map(spec.operations.map((o) => [o.id, o]));
  const workflows: unknown[] = [];
  for (const plan of analysis.plans) {
    if (!plan.inverse) continue;
    const op = opById.get(plan.operationId)!;
    const inputProps: Record<string, unknown> = {};
    for (const p of op.pathParams) inputProps[p] = { type: 'string' };
    if (op.requestSchema) inputProps.body = { type: 'object' };
    const fields = beforeFields(plan, spec);
    const steps: unknown[] = [];
    if (plan.capture) {
      steps.push({
        stepId: 'capture',
        description: 'Read the state the operation is about to change',
        operationId: plan.capture.operationId,
        parameters: stepParams(plan.capture, 'capture'),
        successCriteria: [{ condition: '$statusCode < 300' }],
        outputs: Object.fromEntries(fields.map((f) => [f, `$response.body#/${f}`])),
      });
    }
    const responseOutputs: Record<string, string> = {};
    for (const ref of Object.values(plan.inverse.bindings)) {
      if (ref.from === 'response') responseOutputs[outputName(ref.key)] = `$response.body#/${ref.key.replace(/\./g, '/')}`;
      if (ref.from === 'location') responseOutputs.location = '$response.header.Location';
    }
    steps.push({
      stepId: 'do',
      operationId: op.id,
      parameters: op.pathParams.map((p) => ({ name: p, in: 'path', value: `$inputs.${p}` })),
      ...(op.requestSchema ? { requestBody: { payload: '$inputs.body' } } : {}),
      successCriteria: [{ condition: '$statusCode < 300' }],
      ...(Object.keys(responseOutputs).length ? { outputs: responseOutputs } : {}),
    });
    const undo: Record<string, unknown> = {
      stepId: 'undo',
      description: `${plan.reversibility} via ${plan.strategy}${plan.caveats.length ? ` — ${plan.caveats.join('; ')}` : ''}`,
      operationId: plan.inverse.operationId,
      parameters: stepParams(plan.inverse, 'undo'),
      successCriteria: [{ condition: '$statusCode < 300' }],
    };
    const body = plan.inverse.body;
    if (body?.from === 'literal') undo.requestBody = { payload: body.value };
    if (body?.from === 'request') undo.requestBody = { payload: '$inputs.body' };
    if (body?.from === 'before' || body?.from === 'before-request-keys') {
      undo.requestBody = { payload: Object.fromEntries(fields.map((f) => [f, `$steps.capture.outputs.${f}`])) };
    }
    steps.push(undo);
    workflows.push({
      workflowId: `undo-${op.id.replace(/[^A-Za-z0-9_-]/g, '-')}`,
      summary: `Run ${op.id}, then undo it`,
      'x-undogen-reversibility': plan.reversibility,
      'x-undogen-confidence': plan.confidence,
      inputs: { type: 'object', properties: inputProps },
      steps,
    });
  }
  return stringify({
    arazzo: '1.0.1',
    info: { title: `${spec.title} — undo workflows`, version: spec.version, description: 'Generated by undogen. Compiled plans are hypotheses: run `undogen verify` to prove them.' },
    sourceDescriptions: [{ name: 'api', url: sourceUrl, type: 'openapi' }],
    workflows,
  });
}

function outputName(key: string) {
  return key.replace(/[^A-Za-z0-9_]/g, '_');
}

function stepParams(t: RequestTemplate, step: 'capture' | 'undo'): unknown[] {
  const params: unknown[] = [];
  for (const [name, ref] of Object.entries(t.bindings)) {
    let value: string;
    if (ref.from === 'params') value = `$inputs.${ref.key}`;
    else if (ref.from === 'response') value = `$steps.do.outputs.${outputName(ref.key)}`;
    else if (ref.from === 'location') value = '$steps.do.outputs.location';
    else if (ref.from === 'before') value = `$steps.capture.outputs.${ref.key}`;
    else value = `$inputs.${ref.key}`;
    if (step === 'capture' && ref.from !== 'params') continue;
    params.push({ name, in: 'path', value });
  }
  for (const [name, ref] of Object.entries(t.query ?? {})) params.push({ name, in: 'query', value: `$inputs.${ref.key}` });
  return params;
}

/** Which fields of the captured state the inverse writes back. */
function beforeFields(plan: InversePlan, spec: ApiSpec): string[] {
  const body = plan.inverse?.body;
  if (body?.from === 'before' && body.fields !== '*') return body.fields;
  const op = spec.operations.find((o) => o.id === plan.operationId);
  const props = op?.requestSchema?.properties ?? spec.operations.find((o) => o.id === plan.inverse?.operationId)?.requestSchema?.properties ?? {};
  return Object.entries(props)
    .filter(([, s]) => !s?.readOnly)
    .map(([k]) => k);
}

/**
 * Everything a runtime in another language needs to journal and undo calls:
 * the operations (without schemas) and the compiled plans. The Python client
 * reads this (`undogen compile spec.yaml -o undogen.json`).
 */
export function toBundle(spec: ApiSpec, analysis: Analysis, version: string): object {
  return {
    format: 'undogen-bundle/1',
    generator: `undogen ${version}`,
    spec: analysis.spec,
    operations: spec.operations.map((o) => ({
      id: o.id,
      method: o.method,
      path: o.path,
      summary: o.summary,
      pathParams: o.pathParams,
      queryParams: o.queryParams.map((q) => ({ name: q.name, required: q.required })),
      requestContentType: o.requestContentType,
      hasBody: o.requestSchema !== undefined || o.requestExample !== undefined,
    })),
    plans: analysis.plans,
  };
}
