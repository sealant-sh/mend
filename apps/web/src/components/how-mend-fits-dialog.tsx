import { Button } from "@mend/ui/components/ui/button";
import { useMemo, useState } from "react";

import { screenTitle } from "#/lib/how-mend-fits";
import { fitsDialog } from "#/lib/how-mend-fits-open";
import { type FitsScreen, screenCount } from "#/lib/how-mend-fits-screen";
import { usePhone } from "#/lib/phone";
import { useFitsNames } from "#/lib/use-fits-names";

import { FitsScreenView } from "./fits-screen.tsx";
import { Overlay } from "./projects/overlay.tsx";

/**
 * How Mend fits together, opened again from the account menu (Doop "Account menu · How Mend fits
 * together"; on a phone, from the account row in Settings): the setup step's three screens in a
 * 780px dialog, or a sheet on a phone, with Back, Next and Done. It opens on the first screen.
 * The signed-in layout draws it once; `fitsDialog.open` opens it.
 */
export function HowMendFitsDialog() {
  const phone = usePhone();
  const { open, returnTo } = fitsDialog.use();
  const [screen, setScreen] = useState<FitsScreen>(1);
  // Focus goes back to what opened it: the menu item is gone by then.
  const finalFocus = useMemo(() => ({ current: returnTo }), [returnTo]);
  const show = (next: boolean) => {
    if (next) return;
    fitsDialog.close();
    setScreen(1);
  };
  const size = phone ? "touch" : "default";
  return (
    <Overlay
      open={open}
      onOpenChange={show}
      size="lg"
      finalFocus={finalFocus}
      title={screenTitle(screen, phone)}
      description={screenCount(screen)}
      footer={
        <>
          {screen === 1 ? null : (
            <Button variant="outline" size={size} onClick={() => setScreen(screen === 3 ? 2 : 1)}>
              Back
            </Button>
          )}
          {screen === 3 ? (
            <Button size={size} onClick={() => show(false)}>
              Done
            </Button>
          ) : (
            <Button size={size} onClick={() => setScreen(screen === 1 ? 2 : 3)}>
              Next
            </Button>
          )}
        </>
      }
    >
      {open ? <DialogScreen screen={screen} phone={phone} /> : null}
    </Overlay>
  );
}

/** The screen's body; the names are read only while the dialog is open. */
function DialogScreen({ screen, phone }: { readonly screen: FitsScreen; readonly phone: boolean }) {
  const names = useFitsNames();
  return <FitsScreenView key={screen} screen={screen} names={names} phone={phone} place="dialog" />;
}
