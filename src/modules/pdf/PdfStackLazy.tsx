import { lazy, Suspense } from "react";
import type { ComponentProps } from "react";
import type { PdfStack as PdfStackType } from "./PdfStack";

const PdfStackInner = lazy(() =>
  import("./PdfStack").then((m) => ({ default: m.PdfStack })),
);

type Props = ComponentProps<typeof PdfStackType>;

export function PdfStack(props: Props) {
  return (
    <Suspense fallback={null}>
      <PdfStackInner {...props} />
    </Suspense>
  );
}
