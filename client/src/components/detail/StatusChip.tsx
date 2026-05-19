import type { ReactNode } from "react";
import { toneChipClass, type StatusTone } from "@/lib/statusTones";

export function StatusChip({
  tone = "neutral",
  pulsing = false,
  label,
  title,
  testId,
}: {
  tone?: StatusTone;
  pulsing?: boolean;
  label: ReactNode;
  title?: string;
  testId?: string;
}) {
  const animateClass = pulsing ? " animate-pulse" : "";
  return (
    <span
      data-testid={testId}
      title={title}
      className={`inline-flex items-center rounded-md border px-1.5 py-0 text-label font-medium uppercase tracking-wider ${toneChipClass(tone)}${animateClass}`}
    >
      {label}
    </span>
  );
}
