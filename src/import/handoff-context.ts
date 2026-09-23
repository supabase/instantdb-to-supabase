import { parsePermission } from './permission-expression'
import type { compilePermissions, PermissionRule } from './permissions'
import type { Namespace, Plan } from './types'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const strings = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(strings)
      : value && typeof value === 'object'
        ? Object.values(value).flatMap(strings)
        : []

export function tableContext(ns: Namespace, compact = false) {
  return {
    source: ns.source,
    target: `${ns.destination}.${ns.target}`,
    columns: ns.columns
      .filter((c) => !compact || c.source !== c.target)
      .map((c) =>
        compact
          ? { source: c.source, target: c.target }
          : { source: c.source, target: c.target, type: c.storage, required: c.required }
      ),
    ...(ns.destination === 'public' && ns.source === '$users'
      ? {
          auth_user_id:
            'uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED',
        }
      : ns.destination === 'public' && ns.source === '$files'
        ? {
            storage_object_id:
              'uuid NOT NULL UNIQUE REFERENCES storage.objects(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED',
          }
        : {}),
  }
}

/** Select context only; this does not interpret a rule or change conversion eligibility. */
export function policyContext(
  plan: Plan,
  permissions: ReturnType<typeof compilePermissions>,
  rule: PermissionRule,
  allActions = false
) {
  const source = record(permissions.sourceRules)
  const primary = new Set([rule.namespace])
  const tables = new Set<string>()
  const links = new Set<Plan['links'][number]>()
  const notes = new Set<string>()
  const addLink = (link: Plan['links'][number]) => {
    links.add(link)
    tables.add(link.forward.on)
    tables.add(link.reverse.on)
  }
  if (rule.action.startsWith('link.')) {
    for (const link of plan.links)
      if (`schema.links.${link.source}` === rule.source) {
        addLink(link)
        primary.add(link.forward.on)
        primary.add(link.reverse.on)
      }
  }
  if (rule.action === 'delete') {
    // All incident edges matter for delete authorization, even if the predicate
    // doesn't explicitly traverse them. Follow cascades until the set stabilizes.
    const deleted = new Set(primary)
    for (const ns of deleted)
      for (const link of plan.links) {
        if (link.forward.on !== ns && link.reverse.on !== ns) continue
        addLink(link)
        primary.add(link.forward.on)
        primary.add(link.reverse.on)
        if (link.mapping.kind === 'foreign_key' && link.mapping.onDelete === 'cascade') {
          const owner = link[link.mapping.owner].on
          const referenced = link[link.mapping.owner === 'forward' ? 'reverse' : 'forward'].on
          if (referenced === ns) deleted.add(owner)
        }
      }
  }
  if (rule.namespace === '$default') for (const ns of plan.namespaces) primary.add(ns.source)
  const selected = permissions.rules.filter(
    (r) =>
      primary.has(r.namespace) &&
      (r === rule ||
        r.action.startsWith('fields.') ||
        r.action === 'view' ||
        (allActions || rule.action.startsWith('link.') || rule.action === 'delete'
          ? ['create', 'update', 'delete'].includes(r.action)
          : r.action === rule.action))
  )
  const bindings: Record<string, unknown> = {}
  const restrictions: Record<string, unknown> = {}
  const texts: { namespace: string; text: string }[] = []
  for (const ns of primary) {
    tables.add(ns)
    const local = record(source[ns]),
      global = record(source.$default)
    const localBind = record(local.bind),
      globalBind = record(global.bind)
    const fields = { local: local.fields, global: global.fields }
    if (local.fields !== undefined || global.fields !== undefined) restrictions[ns] = fields
    const expressions = [
      ...strings(selected.filter((r) => r.namespace === ns).map((r) => r.expression)),
      ...strings(fields),
    ]
    const used = new Set<string>()
    for (let i = 0; i < expressions.length; i++) {
      for (const name of expressions[i].match(/[a-zA-Z_$][\w$]*/g) ?? []) {
        if (used.has(name)) continue
        used.add(name)
        // Preserve both scopes when the same binding is defined globally and
        // locally; resolving that ambiguity belongs to the manual conversion.
        if (Object.hasOwn(localBind, name)) expressions.push(...strings(localBind[name]))
        if (Object.hasOwn(globalBind, name)) expressions.push(...strings(globalBind[name]))
      }
    }
    const pick = (values: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(values).filter(([key]) => used.has(key)))
    if (Object.keys(pick(localBind)).length || Object.keys(pick(globalBind)).length)
      bindings[ns] = { local: pick(localBind), global: pick(globalBind) }
    texts.push(...expressions.map((text) => ({ namespace: ns, text })))
  }
  const connectedComponent = (root: string) => {
    const visited = new Set([root])
    for (const ns of visited)
      for (const link of plan.links) {
        if (link.forward.on !== ns && link.reverse.on !== ns) continue
        addLink(link)
        visited.add(link.forward.on)
        visited.add(link.reverse.on)
      }
    notes.add(
      'A dynamic or unresolved reference requires the connected relationship mappings; resolve it using the local migrations before granting access.'
    )
  }
  for (const { namespace, text } of texts) {
    if (/\bauth\b/.test(text)) tables.add('$users')
    for (const match of text.matchAll(/\b(data|newData|auth)\s*\[/g))
      connectedComponent(match[1] === 'auth' ? '$users' : namespace)
    for (const match of text.matchAll(/\b(data|auth)\s*\.\s*ref\s*\(([^)]*)\)/g)) {
      const root = match[1] === 'auth' ? '$users' : namespace
      try {
        const ref = parsePermission(match[0])
        if (ref.kind !== 'ref') throw new Error('Dynamic reference')
        const path = ref.path.split('.')
        if (ref.root === 'auth' && path.shift() !== '$user')
          throw new Error('Unknown auth reference')
        let current = root
        tables.add(root)
        for (const label of path.slice(0, -1)) {
          const candidates = plan.links.flatMap((link) =>
            (['forward', 'reverse'] as const).flatMap((side) =>
              link[side].on === current && link[side].label === label ? [{ link, side }] : []
            )
          )
          if (candidates.length !== 1) throw new Error('Ambiguous reference')
          const { link, side } = candidates[0]
          addLink(link)
          current = link[side === 'forward' ? 'reverse' : 'forward'].on
        }
      } catch {
        connectedComponent(root)
      }
    }
    // Unsupported direct property access can name a relationship as well.
    for (const match of text.matchAll(/\b(?:data|newData)\s*\.\s*([a-zA-Z_$][\w$]*)/g))
      for (const link of plan.links)
        if (
          (link.forward.on === namespace && link.forward.label === match[1]) ||
          (link.reverse.on === namespace && link.reverse.label === match[1])
        )
          addLink(link)
  }
  return {
    tables: plan.namespaces.filter((ns) => tables.has(ns.source)).map((ns) => tableContext(ns)),
    relationships: [...links].map(({ source, forward, reverse, mapping }) => ({
      source,
      forward,
      reverse,
      mapping,
    })),
    sourceRules: selected.map(
      ({ namespace, action, source, expression, status, effect, reason }) => ({
        namespace,
        action,
        source,
        expression,
        status,
        effect,
        reason,
      })
    ),
    ...(Object.keys(bindings).length ? { bindings } : {}),
    ...(Object.keys(restrictions).length ? { fields: restrictions } : {}),
    ...(texts.some(({ text }) => /\brateLimit\b/.test(text))
      ? { rateLimits: source.$rateLimits }
      : {}),
    ...(notes.size ? { notes: [...notes] } : {}),
  }
}
