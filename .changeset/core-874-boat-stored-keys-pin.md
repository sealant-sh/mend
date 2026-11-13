---
"@sealant/mend": patch
---

Update the bundled Sealant Core SDK and images to 0.40.0-next.874.

- **An organization's own Boat key is enough for Boat.** Sealant no longer needs a Boat key in the
  server's environment to keep, check or launch in a key an owner connected. The server's own key
  becomes optional.
- **A Boat session no Boat worker could start is refused when it is asked for.** It no longer waits
  and fails later. In the five minutes after the server starts, it is still accepted and waits.
- **Sealant keeps the name of this server's Boat VMs and the owner of its Boat images.** Mend's
  setup still hands them over, so a server that already runs Boat keeps recognising its VMs and
  images.
- **Boat keys are checked again every day.** What the Boat page shows is at most a day old.
- **An image build Boat refused for a reason a person can fix is built again once that reason
  clears,** when the key is replaced or a check shows the cause gone.
