// Bitácora (`/app/audit`, docs/design-brief.md §6; FL-088): the world's decisions with the rule applied,
// the trigger and the actor, filterable by decision and by rule; the violations `PolicyAudit` found (it
// must be 0) next to ALLOW, DENY and DEFER per rule; and the blocks by origin. It follows the shell's clock
// poll.
import { useState } from "react";
import { Badge } from "../../components/Badge";
import { FilterPills } from "../../components/FilterPills";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import { RuleChip } from "../../components/RuleChip";
import { RuleChips } from "../../components/RuleChips";
import { Section } from "../../components/Section";
import { SelectField } from "../../components/SelectField";
import { StatGrid, StatTile } from "../../components/StatTile";
import { Table } from "../../components/Table";
import { useSession } from "../../context/SessionContext";
import { useWorldClock } from "../../context/WorldClockContext";
import { copy as consoleCopy } from "../../copy/console";
import { Link } from "../../lib/router";
import { dataOf, useRemote } from "../../lib/use-remote";
import type { ViewProps } from "../../lib/view-registry";
import { formatSimTime } from "../../lib/world-clock";
import { pathOf } from "../../routes";
import { codeLabel } from "../../lib/code-label";
import { type ByRule, DECISION_FILTERS, type DecisionFilter, type DecisionRow, actionText, actorText, decisionTone, listInput, monthLabel, reasonText, ruleOptions, totals, triggerText } from "./audit-model";
import { auditCopy as copy } from "./copy";

function Summary({ byRule, violations }: { readonly byRule: ByRule; readonly violations: number }) {
  const sum = totals(byRule);
  return (
    <Section id="audit-summary" title={copy.summary.title} description={copy.summary.month(monthLabel(byRule.month))}>
      <StatGrid>
        <StatTile label={copy.summary.violations} value={violations} hint={copy.summary.violationsHint} tone={violations === 0 ? "success" : "danger"} />
        <StatTile label={copy.summary.denied} value={sum.deny} />
        <StatTile label={copy.summary.deferred} value={sum.defer} />
      </StatGrid>
    </Section>
  );
}

function RulesAndBlocks({ byRule }: { readonly byRule: ByRule }) {
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <Section id="audit-rules" title={copy.byRule.title} description={copy.byRule.description}>
        <Table
          caption={copy.byRule.title}
          columns={[
            { id: "rule", header: copy.byRule.rule, cell: (rule: ByRule["rules"][number]) => (rule.ruleId === "NONE" ? copy.byRule.none : <RuleChip ruleId={rule.ruleId} />) },
            { id: "allow", header: copy.byRule.allow, align: "right", cell: (rule: ByRule["rules"][number]) => rule.ALLOW },
            { id: "deny", header: copy.byRule.deny, align: "right", cell: (rule: ByRule["rules"][number]) => rule.DENY },
            { id: "defer", header: copy.byRule.defer, align: "right", cell: (rule: ByRule["rules"][number]) => rule.DEFER },
          ]}
          rows={byRule.rules}
          keyOf={(rule) => rule.ruleId}
          emptyTitle={copy.byRule.empty}
        />
      </Section>
      <Section id="audit-blocks" title={copy.blocks.title}>
        <Table
          caption={copy.blocks.title}
          columns={[
            { id: "origin", header: copy.blocks.origin, cell: (block: ByRule["blocks"][number]) => codeLabel(copy.blocks.origins, block.origin) },
            { id: "count", header: copy.blocks.count, align: "right", cell: (block: ByRule["blocks"][number]) => block.count },
          ]}
          rows={byRule.blocks}
          keyOf={(block) => block.origin}
          emptyTitle={copy.blocks.empty}
        />
      </Section>
    </div>
  );
}

const COLUMNS = [
  { id: "when", header: copy.list.when, cell: (row: DecisionRow) => <span className="tabular-nums">{row.atSim ? formatSimTime(row.atSim, consoleCopy.clock.weekdays) : copy.noValue}</span> },
  { id: "decision", header: copy.list.decision, cell: (row: DecisionRow) => <Badge tone={decisionTone(row.decision)}>{copy.decisionBadge[row.decision] ?? row.decision}</Badge> },
  { id: "action", header: copy.list.action, cell: (row: DecisionRow) => actionText(row.action) },
  { id: "rules", header: copy.list.rules, cell: (row: DecisionRow) => <RuleChips ruleIds={row.ruleIds} label={copy.list.rulesLabel} emptyText={copy.noValue} /> },
  { id: "trigger", header: copy.list.trigger, cell: (row: DecisionRow) => triggerText(row.trigger) },
  { id: "actor", header: copy.list.actor, cell: (row: DecisionRow) => actorText(row.actor) },
  { id: "reason", header: copy.list.reason, cell: (row: DecisionRow) => reasonText(row.reason) },
  {
    id: "order",
    header: copy.list.order,
    cell: (row: DecisionRow) =>
      row.workOrderId ? (
        <Link to={`${pathOf("orders")}/${row.workOrderId}`} className="text-sm font-semibold text-cyan-deep underline">
          {copy.list.order}
        </Link>
      ) : (
        copy.noValue
      ),
  },
];

export default function AuditView(_props: ViewProps) {
  const { trpc } = useSession();
  const { tick } = useWorldClock();
  const [decision, setDecision] = useState<DecisionFilter>("ALL");
  const [ruleId, setRuleId] = useState("");
  const input = listInput(decision, ruleId);
  const byRule = useRemote(`audit.decisionsByRule:${tick}`, (signal) => trpc.audit.decisionsByRule.query(undefined, { signal }));
  const violations = useRemote(`audit.violations:${tick}`, (signal) => trpc.audit.violations.query(undefined, { signal }));
  const list = useRemote(`audit.list:${JSON.stringify(input)}:${tick}`, (signal) => trpc.audit.list.query(input, { signal }));
  const rules = ruleOptions(dataOf(byRule.state));
  const found = dataOf(violations.state);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={consoleCopy.views.audit.title} description={consoleCopy.views.audit.description} />
      <RemoteBlock state={byRule.state} onRetry={byRule.reload}>
        {(data) => (
          <>
            <Summary byRule={data} violations={found?.count ?? data.violations} />
            {found !== undefined && found.count > 0 ? (
              <Section id="audit-violations" title={copy.violations.title}>
                <ul className="list-disc space-y-1 pl-5 text-sm text-danger">
                  {found.violations.map((row) => (
                    <li key={row.decisionId}>
                      {actionText(row.action)}
                      {row.check ? ` · ${copy.violations.check}: ${codeLabel({}, row.check)}` : ""}
                    </li>
                  ))}
                </ul>
              </Section>
            ) : (
              <p className="text-sm text-success">{copy.violations.none}</p>
            )}
            <RulesAndBlocks byRule={data} />
          </>
        )}
      </RemoteBlock>
      <Section id="audit-list" title={copy.list.title} description={copy.list.description}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-4">
            <FilterPills label={copy.list.filter} value={decision} onChange={setDecision} options={DECISION_FILTERS.map((value) => ({ value, label: copy.decisions[value] ?? value }))} />
            <SelectField label={copy.list.rule} value={ruleId} options={[{ value: "", label: copy.list.allRules }, ...rules.map((value) => ({ value, label: value }))]} onChange={setRuleId} className="min-w-48" />
          </div>
          <RemoteBlock state={list.state} onRetry={list.reload}>
            {(data) => (
              <>
                <p className="text-xs text-slate">{copy.list.shown(data.decisions.length, data.total)}</p>
                <Table caption={copy.list.caption} columns={COLUMNS} rows={data.decisions} keyOf={(row) => row.decisionId} emptyTitle={copy.list.empty} />
              </>
            )}
          </RemoteBlock>
        </div>
      </Section>
    </div>
  );
}
