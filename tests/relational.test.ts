import { describe, expect, it } from 'vitest'

import { analyze } from '../src/import/plan'
import { buildSchema } from '../src/import/sql'
import { attr } from './fixtures'

export function relationalInput() {
  return new Map([
    [
      'config.json',
      Buffer.from(
        JSON.stringify({
          schema: {
            entities: {
              tasks: { attrs: { title: attr(), dueAt: attr('date') } },
              projects: { attrs: { title: attr() } },
              labels: { attrs: { name: attr() } },
              profiles: { attrs: { displayName: attr() } },
              $users: { attrs: { email: attr() } },
              featureFlags: { attrs: { enabled: attr('boolean') } },
              organizations: { attrs: { name: attr() } },
            },
            links: {
              tasksProject: {
                forward: {
                  on: 'tasks',
                  label: 'project',
                  has: 'one',
                  required: true,
                  onDelete: 'cascade',
                },
                reverse: { on: 'projects', label: 'tasks', has: 'many' },
              },
              tasksLabels: {
                forward: { on: 'tasks', label: 'labels', has: 'many' },
                reverse: { on: 'labels', label: 'tasks', has: 'many' },
              },
              profilesUser: {
                forward: { on: 'profiles', label: '$user', has: 'one', required: true },
                reverse: { on: '$users', label: 'profile', has: 'one' },
              },
              organizationsFlags: {
                forward: { on: 'organizations', label: 'flags', has: 'many' },
                reverse: {
                  on: 'featureFlags',
                  label: 'organization',
                  has: 'one',
                  onDelete: 'cascade',
                },
              },
              tasksParent: {
                forward: { on: 'tasks', label: 'parent', has: 'one' },
                reverse: { on: 'tasks', label: 'children', has: 'many' },
              },
            },
          },
        })
      ),
    ],
  ])
}

describe('human-readable relational model', () => {
  it('creates readable tables and typed columns in public', () => {
    const plan = analyze(relationalInput())
    expect(plan.namespaces.find((n) => n.source === 'featureFlags')!.target).toBe('feature_flags')
    expect(plan.namespaces.find((n) => n.source === '$users')!.target).toBe('users')
    expect(
      plan.namespaces.find((n) => n.source === 'tasks')!.columns.find((c) => c.source === 'dueAt')!
        .target
    ).toBe('due_at')
    const sql = buildSchema(plan, 'instant_test').join('\n')
    expect(sql).toContain('CREATE TABLE public.tasks')
    expect(sql).toContain('due_at timestamptz')
  })
  it('uses a required FK on the many side instead of a relationship table', () => {
    const plan = analyze(relationalInput())
    expect(plan.links.find((l) => l.source === 'tasksProject')!.mapping).toEqual({
      kind: 'foreign_key',
      table: 'tasks',
      column: 'project_id',
      referencedTable: 'projects',
      owner: 'forward',
      required: true,
      unique: false,
      onDelete: 'cascade',
    })
    const sql = buildSchema(plan, 'instant_test').join('\n')
    expect(sql).not.toContain('CREATE TABLE public.tasks_project')
    expect(sql).toContain(
      'FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE'
    )
  })
  it('puts a one-to-one FK on the required side with a unique constraint', () => {
    const plan = analyze(relationalInput())
    expect(plan.links.find((l) => l.source === 'profilesUser')!.mapping).toMatchObject({
      kind: 'foreign_key',
      table: 'profiles',
      column: 'user_id',
      referencedTable: 'users',
      required: true,
      unique: true,
    })
    expect(buildSchema(plan, 'instant_test').join('\n')).toContain('UNIQUE (user_id)')
  })
  it('reverses FK placement when the exported forward direction is many', () => {
    expect(
      analyze(relationalInput()).links.find((l) => l.source === 'organizationsFlags')!.mapping
    ).toEqual({
      kind: 'foreign_key',
      table: 'feature_flags',
      column: 'organization_id',
      referencedTable: 'organizations',
      owner: 'reverse',
      required: false,
      unique: false,
      onDelete: 'cascade',
    })
  })
  it('creates only genuine many-to-many junctions with meaningful column names', () => {
    const plan = analyze(relationalInput())
    expect(plan.links.filter((l) => l.mapping.kind === 'junction')).toHaveLength(1)
    expect(plan.links.find((l) => l.source === 'tasksLabels')!.mapping).toEqual({
      kind: 'junction',
      table: 'tasks_labels',
      sourceColumn: 'task_id',
      targetColumn: 'label_id',
    })
    const sql = buildSchema(plan, 'instant_test').join('\n')
    expect(sql).toContain('PRIMARY KEY (task_id, label_id)')
  })
  it('reports a source cascade the generated foreign key cannot express', () => {
    const plan = analyze(relationalInput())
    expect(plan.diagnostics.some((d) => d.code === 'cascade_not_representable')).toBe(false)
    const input = relationalInput(),
      config = JSON.parse(input.get('config.json')!.toString())
    // The required side owns the FK, so the other side's cascade has nowhere to go.
    config.schema.links.profilesUser.reverse.onDelete = 'cascade'
    input.set('config.json', Buffer.from(JSON.stringify(config)))
    const reported = analyze(input)
    expect(reported.links.find((l) => l.source === 'profilesUser')!.mapping).toMatchObject({
      owner: 'forward',
      onDelete: 'no action',
    })
    expect(reported.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'cascade_not_representable', resource: 'profilesUser' })
    )
  })
  it('reports a source cascade on a relationship that becomes a junction table', () => {
    const input = relationalInput(),
      config = JSON.parse(input.get('config.json')!.toString())
    config.schema.links.tasksLabels.forward.onDelete = 'cascade'
    input.set('config.json', Buffer.from(JSON.stringify(config)))
    const plan = analyze(input)
    expect(plan.links.find((l) => l.source === 'tasksLabels')!.mapping.kind).toBe('junction')
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'cascade_not_representable', resource: 'tasksLabels' })
    )
  })
  it('supports self-referencing FKs', () => {
    expect(
      analyze(relationalInput()).links.find((l) => l.source === 'tasksParent')!.mapping
    ).toMatchObject({ table: 'tasks', column: 'parent_id', referencedTable: 'tasks' })
  })
  it('keeps import metadata out of public entity tables', () => {
    const sql = buildSchema(analyze(relationalInput()), 'instant_test').join('\n')
    const tasks = sql.split('\n').find((s) => s.startsWith('CREATE TABLE public.tasks ('))!
    expect(tasks).not.toMatch(/source_record|source_presence|source_created_at/)
    expect(sql).toContain('CREATE TABLE instant_test.provenance')
  })
  it('resolves field/FK, normalized-name, long-name, and system-column collisions deterministically', () => {
    const input = relationalInput(),
      config = JSON.parse(input.get('config.json')!.toString())
    config.schema.entities.tasks.attrs.projectId = attr()
    config.schema.entities.tasks.attrs.project_id = attr()
    config.schema.entities.tasks.attrs.ctid = attr()
    config.schema.entities['資料'.repeat(40)] = { attrs: { ['字段'.repeat(40)]: attr() } }
    input.set('config.json', Buffer.from(JSON.stringify(config)))
    const plan = analyze(input)
    for (const ns of plan.namespaces) {
      const names = [
        'id',
        ...ns.columns.map((c) => c.target),
        ...plan.links.flatMap((l) =>
          l.mapping.kind === 'foreign_key' && l.mapping.table === ns.target
            ? [l.mapping.column]
            : []
        ),
      ]
      expect(new Set(names).size).toBe(names.length)
      expect(names).not.toContain('ctid')
      expect(Buffer.byteLength(ns.target)).toBeLessThanOrEqual(63)
      for (const name of names) expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63)
    }
    expect(analyze(new Map([...input].reverse()))).toEqual(plan)
  })
})
