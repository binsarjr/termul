import { Streamdown } from "streamdown";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useWhatsNewStore } from "./whatsNewStore";

export function WhatsNewDialog() {
  const open = useWhatsNewStore((s) => s.open);
  const version = useWhatsNewStore((s) => s.version);
  const notes = useWhatsNewStore((s) => s.notes);
  const dismiss = useWhatsNewStore((s) => s.dismiss);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{`What's new in Termul ${version}`}</DialogTitle>
          <DialogDescription>
            Here is what changed in this update.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto pr-1 text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:tracking-wide [&_h3]:text-muted-foreground [&_h3]:uppercase [&_li]:my-1 [&_ul]:list-disc [&_ul]:pl-5">
          <Streamdown>{notes}</Streamdown>
        </div>
        <DialogFooter>
          <Button onClick={dismiss}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
