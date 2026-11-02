import { sharedControlConfirm } from "@mend/domain/workbench";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mend/ui/components/ui/dialog";

import { SharedControlConfirmBody } from "./shared-workspace";

/** What the switch asks before shared control goes on, as a dialog; loaded when it first opens. */
export function SharedControlConfirmDialog({
  open,
  turnsOnSendersLogin,
  pending,
  onConfirm,
  onCancel,
}: {
  readonly open: boolean;
  readonly turnsOnSendersLogin: boolean;
  readonly pending: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const words = sharedControlConfirm(turnsOnSendersLogin);
  return (
    <Dialog
      open={open}
      disablePointerDismissal={pending}
      onOpenChange={(next) => {
        if (!next && !pending) onCancel();
      }}
    >
      {open && (
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{words.title}</DialogTitle>
            <DialogDescription>{words.body}</DialogDescription>
          </DialogHeader>
          <SharedControlConfirmBody
            turnsOnSendersLogin={turnsOnSendersLogin}
            pending={pending}
            onConfirm={onConfirm}
            onCancel={onCancel}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}
