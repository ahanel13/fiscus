import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { householdQuery, membersQuery } from '../api/queries.js';
import { EmptyState } from '../components/EmptyState.js';
import { PageHeader } from '../components/PageHeader.js';
import { lensVisible } from '../lib/lens.js';
import type { Section } from '../lib/nav.js';

/** A section page. Until its milestone lands it shows the header and an explanatory empty state. */
export function SectionPage({ section }: { section: Section }) {
  const { householdId } = useParams({ strict: false }) as { householdId: string };
  const household = useSuspenseQuery(householdQuery(householdId)).data;
  const members = useQuery(membersQuery(householdId)).data ?? [];
  return (
    <>
      <PageHeader
        title={section.label}
        showRange={section.hasRange}
        showLens={lensVisible(household, members.length)}
        members={members}
      />
      <div className="px-4 py-10 md:px-8">
        <EmptyState icon={section.icon} title={`${section.label} is on the way`}>
          <p>{section.blurb}</p>
          <p className="text-xs">Planned for milestone {section.milestone}.</p>
        </EmptyState>
      </div>
    </>
  );
}
