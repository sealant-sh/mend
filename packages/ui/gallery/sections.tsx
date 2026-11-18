import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@mend/ui/components/ui/accordion";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@mend/ui/components/ui/alert-dialog";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentTitle,
} from "@mend/ui/components/ui/attachment";
import {
  Autocomplete,
  AutocompleteContent,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
} from "@mend/ui/components/ui/autocomplete";
import { Avatar, AvatarFallback } from "@mend/ui/components/ui/avatar";
import { Badge } from "@mend/ui/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@mend/ui/components/ui/breadcrumb";
import { Bubble, BubbleContent } from "@mend/ui/components/ui/bubble";
import { Button } from "@mend/ui/components/ui/button";
import { ButtonGroup } from "@mend/ui/components/ui/button-group";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@mend/ui/components/ui/card";
import { Checkbox } from "@mend/ui/components/ui/checkbox";
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockLine,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@mend/ui/components/ui/code-block";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mend/ui/components/ui/collapsible";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@mend/ui/components/ui/command";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@mend/ui/components/ui/context-menu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@mend/ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@mend/ui/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@mend/ui/components/ui/field";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@mend/ui/components/ui/hover-card";
import { Input } from "@mend/ui/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@mend/ui/components/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@mend/ui/components/ui/item";
import { Kbd, KbdGroup } from "@mend/ui/components/ui/kbd";
import { Label } from "@mend/ui/components/ui/label";
import { Marker, MarkerContent } from "@mend/ui/components/ui/marker";
import { Message, MessageContent, MessageFooter } from "@mend/ui/components/ui/message";
import { NativeSelect, NativeSelectOption } from "@mend/ui/components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@mend/ui/components/ui/popover";
import { Progress } from "@mend/ui/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@mend/ui/components/ui/radio-group";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@mend/ui/components/ui/resizable";
import { ScrollArea } from "@mend/ui/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mend/ui/components/ui/select";
import { Separator } from "@mend/ui/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@mend/ui/components/ui/sheet";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@mend/ui/components/ui/sidebar";
import { Skeleton } from "@mend/ui/components/ui/skeleton";
import { Spinner } from "@mend/ui/components/ui/spinner";
import { Switch } from "@mend/ui/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@mend/ui/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@mend/ui/components/ui/tabs";
import { Textarea } from "@mend/ui/components/ui/textarea";
import { useToastManager } from "@mend/ui/components/ui/toast";
import { Toggle } from "@mend/ui/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@mend/ui/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mend/ui/components/ui/tooltip";
import { Trace, TraceLine, TraceTitle } from "@mend/ui/components/ui/trace";
import { useHighlightedCode } from "@mend/ui/hooks/use-highlighted-code";
import {
  BellIcon,
  CopyIcon,
  FileDiffIcon,
  FolderIcon,
  InboxIcon,
  LayoutPanelLeftIcon,
  PencilIcon,
  SearchIcon,
  SquareTerminalIcon,
  TrashIcon,
} from "lucide-react";
import type * as React from "react";

import { componentSections } from "./components.tsx";

// `?open=dialog` (or menu, alert-dialog, sheet, sheet-lg, context-menu) opens that overlay on load,
// for screenshots.
const open = new URLSearchParams(window.location.search).get("open");

function Row({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      {label === undefined ? null : (
        <span className="text-meta text-muted-foreground">{label}</span>
      )}
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

const buttonVariants = ["default", "secondary", "outline", "ghost", "destructive", "link"] as const;
const buttonSizes = ["default", "sm", "touch"] as const;

function ButtonDemo() {
  return (
    <div className="flex flex-col gap-4">
      {buttonSizes.map((size) => (
        <Row key={size} label={`size ${size}`}>
          {buttonVariants.map((variant) => (
            <Button key={variant} variant={variant} size={size}>
              {variant === "destructive" ? "Stop session" : "Land change"}
            </Button>
          ))}
        </Row>
      ))}
      <Row label="also from shadcn: xs, lg, icon sizes, disabled">
        <Button size="xs">Copy</Button>
        <Button size="lg">Create project</Button>
        <Button size="icon" variant="outline" aria-label="Copy">
          <CopyIcon />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Edit">
          <PencilIcon />
        </Button>
        <Button size="icon-touch" variant="secondary" aria-label="Search">
          <SearchIcon />
        </Button>
        <Button disabled>Send</Button>
      </Row>
      <Row label="button group">
        <ButtonGroup>
          <Button variant="outline">Unified</Button>
          <Button variant="outline">Split</Button>
        </ButtonGroup>
      </Row>
    </div>
  );
}

function KbdDemo() {
  return (
    <Row>
      <Kbd>⌘K</Kbd>
      <KbdGroup>
        <Kbd>⌥</Kbd>
        <Kbd>1</Kbd>
      </KbdGroup>
      <Kbd>F2</Kbd>
      <Kbd>Esc</Kbd>
    </Row>
  );
}

function SwitchDemo() {
  return (
    <Row>
      <Label className="gap-2">
        <Switch defaultChecked /> On
      </Label>
      <Label className="gap-2">
        <Switch /> Off
      </Label>
      <Label className="gap-2">
        <Switch size="sm" defaultChecked /> Small
      </Label>
      <Label className="gap-2">
        <Switch disabled /> Disabled
      </Label>
    </Row>
  );
}

function DialogDemo() {
  const sizes = ["sm", "md", "lg"] as const;
  return (
    <Row>
      {sizes.map((size) => (
        <Dialog
          key={size}
          defaultOpen={open === `dialog-${size}` || (open === "dialog" && size === "md")}
        >
          <DialogTrigger render={<Button variant="secondary" />}>Dialog {size}</DialogTrigger>
          <DialogContent size={size}>
            <DialogHeader>
              <DialogTitle>Rename session</DialogTitle>
              <DialogDescription>
                The new name shows in the sidebar and on its tab.
              </DialogDescription>
            </DialogHeader>
            <Input defaultValue="Fix flaky checkout retry" aria-label="Session name" />
            <DialogFooter>
              <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
              <Button>Rename</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ))}
      <AlertDialog defaultOpen={open === "alert-dialog"}>
        <AlertDialogTrigger render={<Button variant="destructive" />}>
          Stop session…
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop session?</AlertDialogTitle>
            <AlertDialogDescription>
              The agent stops. No other session in this workspace is running, so the workspace and
              its services stop too.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive">Stop session</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Row>
  );
}

function SideSheetDemo() {
  const sizes = ["md", "lg"] as const;
  return (
    <Row>
      {sizes.map((size) => (
        <Sheet
          key={size}
          defaultOpen={open === `sheet-${size}` || (open === "sheet" && size === "md")}
        >
          <SheetTrigger render={<Button variant="secondary" />}>Side sheet {size}</SheetTrigger>
          <SheetContent size={size}>
            <SheetHeader>
              <SheetTitle>Audit log</SheetTitle>
              <SheetDescription>What changed in Northwind in the last 30 days.</SheetDescription>
            </SheetHeader>
            <div className="flex flex-col divide-y px-4">
              {[
                "Ada Lovelace made Mae Jemison an owner",
                "Grace Hopper joined",
                "Boat key changed",
              ].map((line) => (
                <p key={line} className="py-2 text-row">
                  {line}
                </p>
              ))}
            </div>
            <SheetFooter>
              <Button variant="secondary">Export</Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      ))}
    </Row>
  );
}

function MenuItems() {
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel>Session</DropdownMenuLabel>
        <DropdownMenuItem>
          <PencilIcon /> Rename…
          <DropdownMenuShortcut>F2</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem>
          <CopyIcon /> Copy link
        </DropdownMenuItem>
        <DropdownMenuCheckboxItem checked>Show in sidebar</DropdownMenuCheckboxItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <BellIcon /> Snooze
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent width="sm">
            <DropdownMenuItem>For an hour</DropdownMenuItem>
            <DropdownMenuItem>Until tomorrow</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem disabled>
          <FolderIcon /> Move to project
        </DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive">
        <TrashIcon /> Stop session…
      </DropdownMenuItem>
    </>
  );
}

function MenuDemo() {
  const widths = ["sm", "md", "lg"] as const;
  return (
    <Row>
      {widths.map((width) => (
        <DropdownMenu
          key={width}
          defaultOpen={open === `menu-${width}` || (open === "menu" && width === "md")}
        >
          <DropdownMenuTrigger render={<Button variant="outline" />}>
            Menu {width}
          </DropdownMenuTrigger>
          <DropdownMenuContent width={width}>
            <MenuItems />
          </DropdownMenuContent>
        </DropdownMenu>
      ))}
      <ContextMenu>
        <ContextMenuTrigger className="flex h-16 w-48 items-center justify-center rounded-lg border border-dashed text-meta text-muted-foreground">
          Right-click here
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>
            Rename…<ContextMenuShortcut>F2</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem>Mark done</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive">Stop session…</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </Row>
  );
}

function ToastDemo() {
  const toasts = useToastManager();
  function show() {
    toasts.add({
      description: "Snoozed “Upgrade to React Router 8” until tomorrow at 09:00.",
      actionProps: { children: "Undo" },
      timeout: open === "toast" ? 0 : 5000,
    });
  }
  return (
    <Row>
      <Button variant="secondary" onClick={show} ref={open === "toast" ? autoClick : undefined}>
        Show toast
      </Button>
      <span className="text-meta text-muted-foreground">The 390px mode shows the touch size.</span>
    </Row>
  );
}

// Opens the toast once on load for `?open=toast`.
let clicked = false;
function autoClick(button: HTMLButtonElement | null) {
  if (button !== null && !clicked) {
    clicked = true;
    queueMicrotask(() => button.click());
  }
}

function EmptyDemo() {
  return (
    <div className="flex flex-col gap-4">
      <Row label="kind page">
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia className="text-muted-foreground">
              <InboxIcon className="size-6" />
            </EmptyMedia>
            <EmptyTitle>No sessions yet</EmptyTitle>
            <EmptyDescription>
              Sessions you start show here, grouped by what they're waiting on.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button>New session</Button>
          </EmptyContent>
        </Empty>
      </Row>
      <Row label="kind inline">
        <div className="w-full max-w-sm border-y">
          <p className="px-3 pt-2 text-meta font-semibold text-muted-foreground">Waiting on you</p>
          <Empty kind="inline">
            Nothing is waiting on you. When an agent asks a question or wants approval, the session
            shows here.
          </Empty>
        </div>
      </Row>
    </div>
  );
}

function FormDemo() {
  return (
    <div className="grid max-w-xl gap-4">
      <Field>
        <FieldLabel htmlFor="g-name">Project name</FieldLabel>
        <Input id="g-name" placeholder="checkout-api" />
        <FieldDescription>Everyone who can open the project sees this name.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="g-base">Start from</FieldLabel>
        <Autocomplete items={["main", "release/2.4", "fix-checkout-retry"]}>
          <AutocompleteInput id="g-base" placeholder="main" className="w-full font-mono" />
          <AutocompleteContent>
            <AutocompleteEmpty>No branch matches. Mend tries what you typed.</AutocompleteEmpty>
            <AutocompleteList>
              {(branch: string) => (
                <AutocompleteItem key={branch} value={branch} className="font-mono">
                  {branch}
                </AutocompleteItem>
              )}
            </AutocompleteList>
          </AutocompleteContent>
        </Autocomplete>
        <FieldDescription>Any branch, tag or commit. Empty starts from main.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="g-notes">Notes</FieldLabel>
        <Textarea id="g-notes" placeholder="What the agent should know" />
      </Field>
      <Field>
        <FieldLabel htmlFor="g-key">Mend key</FieldLabel>
        <InputGroup>
          <InputGroupInput
            id="g-key"
            readOnly
            value="ssh-ed25519 AAAAC3Nza…k2 mend"
            className="font-mono"
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton variant="outline" size="sm">
              Copy key
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </Field>
      <Row>
        <Label className="gap-2">
          <Checkbox defaultChecked /> Land when a turn completes
        </Label>
        <RadioGroup defaultValue="mine" className="flex gap-4">
          <Label className="gap-2">
            <RadioGroupItem value="all" /> All projects
          </Label>
          <Label className="gap-2">
            <RadioGroupItem value="mine" /> Mine
          </Label>
        </RadioGroup>
      </Row>
      <Row>
        <Select items={{ claude: "Claude Code", codex: "Codex" }} defaultValue="claude">
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="claude">Claude Code</SelectItem>
            <SelectItem value="codex">Codex</SelectItem>
          </SelectContent>
        </Select>
        <NativeSelect defaultValue="light" aria-label="Theme">
          <NativeSelectOption value="system">System</NativeSelectOption>
          <NativeSelectOption value="light">Light</NativeSelectOption>
          <NativeSelectOption value="dark">Dark</NativeSelectOption>
        </NativeSelect>
        <NativeSelect size="field" defaultValue="13" aria-label="Terminal font size">
          <NativeSelectOption value="12">12 px</NativeSelectOption>
          <NativeSelectOption value="13">13 px</NativeSelectOption>
          <NativeSelectOption value="15">15 px</NativeSelectOption>
        </NativeSelect>
      </Row>
    </div>
  );
}

function ChoicesDemo() {
  return (
    <div className="flex flex-col gap-4">
      <Row label="toggle and toggle group">
        <Toggle aria-label="Wrap lines">Wrap</Toggle>
        <Toggle variant="outline" aria-label="Show whitespace">
          Whitespace
        </Toggle>
        <ToggleGroup variant="outline" defaultValue={["unified"]}>
          <ToggleGroupItem value="unified">Unified</ToggleGroupItem>
          <ToggleGroupItem value="split">Split</ToggleGroupItem>
        </ToggleGroup>
      </Row>
      <Row label="tabs">
        <Tabs defaultValue="change">
          <TabsList>
            <TabsTrigger value="change">
              <FileDiffIcon /> Change
            </TabsTrigger>
            <TabsTrigger value="terminal">
              <SquareTerminalIcon /> Terminal
            </TabsTrigger>
          </TabsList>
          <TabsContent value="change" className="text-row">
            4 files changed.
          </TabsContent>
          <TabsContent value="terminal" className="text-row">
            No terminal open.
          </TabsContent>
        </Tabs>
        <Tabs defaultValue="change">
          <TabsList variant="line">
            <TabsTrigger value="change">Change</TabsTrigger>
            <TabsTrigger value="details">Details</TabsTrigger>
          </TabsList>
        </Tabs>
      </Row>
    </div>
  );
}

function OverlaysDemo() {
  return (
    <Row>
      <Tooltip>
        <TooltipTrigger render={<Button variant="outline" />}>Tooltip</TooltipTrigger>
        <TooltipContent>
          Layout <Kbd>⌥1</Kbd>
        </TooltipContent>
      </Tooltip>
      <Popover>
        <PopoverTrigger render={<Button variant="outline" />}>Popover</PopoverTrigger>
        <PopoverContent>Checks run when the session's turn ends.</PopoverContent>
      </Popover>
      <HoverCard>
        <HoverCardTrigger render={<Button variant="link" />}>Hover card</HoverCardTrigger>
        <HoverCardContent>Ada Lovelace, owner of Northwind.</HoverCardContent>
      </HoverCard>
    </Row>
  );
}

function CommandDemo() {
  return (
    <Command className="max-w-palette rounded-palette border shadow-pop">
      <CommandInput placeholder="Search Northwind" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem>
            <LayoutPanelLeftIcon /> Conversation beside change
            <CommandShortcut>⌥2</CommandShortcut>
          </CommandItem>
          <CommandItem>
            <PencilIcon /> New session
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

function DataDemo() {
  return (
    <div className="flex flex-col gap-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Member</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Joined</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[
            ["AL", "Ada Lovelace", "Owner", "2 Mar"],
            ["GH", "Grace Hopper", "Member", "4 Mar"],
          ].map(([initials, name, role, joined]) => (
            <TableRow key={name}>
              <TableCell className="flex items-center gap-2">
                <Avatar size="sm">
                  <AvatarFallback>{initials}</AvatarFallback>
                </Avatar>
                {name}
              </TableCell>
              <TableCell>{role}</TableCell>
              <TableCell className="text-muted-foreground">{joined}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Item variant="outline" className="max-w-md">
        <ItemContent>
          <ItemTitle>Fix flaky checkout retry</ItemTitle>
          <ItemDescription>checkout-api · Waiting on you · 4m</ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button size="sm" variant="secondary">
            Open
          </Button>
        </ItemActions>
      </Item>
      <Row label="badge">
        {(["default", "secondary", "outline", "destructive", "ghost", "link"] as const).map(
          (variant) => (
            <Badge key={variant} variant={variant}>
              {variant}
            </Badge>
          ),
        )}
      </Row>
      <Row label="progress, skeleton, spinner">
        <Progress value={60} className="w-48" />
        <Skeleton className="h-4 w-32" />
        <Spinner />
      </Row>
    </div>
  );
}

function StructureDemo() {
  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="#settings">Settings</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink href="#account">Account</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Notifications</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <Accordion className="max-w-md">
        <AccordionItem value="services">
          <AccordionTrigger>Services</AccordionTrigger>
          <AccordionContent>postgres and redis are running.</AccordionContent>
        </AccordionItem>
        <AccordionItem value="checks">
          <AccordionTrigger>Checks</AccordionTrigger>
          <AccordionContent>Tests passed at checkpoint 5.</AccordionContent>
        </AccordionItem>
      </Accordion>
      <Collapsible>
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
          Show 3 earlier turns
        </CollapsibleTrigger>
        <CollapsibleContent className="text-row text-muted-foreground">
          Turns 1 to 3.
        </CollapsibleContent>
      </Collapsible>
      <Card className="max-w-sm">
        <CardHeader>
          <CardTitle>Card</CardTitle>
          <CardDescription>
            Sheet groups with hairlines, not cards; this is shadcn's as generated.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-row">Content</CardContent>
      </Card>
      <ScrollArea className="h-24 max-w-sm rounded-lg border p-3">
        {Array.from({ length: 12 }, (_, line) => (
          <p key={line} className="font-mono text-2xs text-muted-foreground">
            line {line + 1}
          </p>
        ))}
      </ScrollArea>
      <div className="h-32 max-w-md rounded-lg border">
        <ResizablePanelGroup>
          <ResizablePanel className="p-3 text-row">Conversation</ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel className="p-3 text-row">Change</ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <Separator />
    </div>
  );
}

function SidebarDemo() {
  return (
    <div className="h-72 overflow-hidden rounded-lg border">
      <SidebarProvider className="min-h-0">
        <Sidebar collapsible="none" className="h-72">
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel className="text-warning">Waiting on you</SidebarGroupLabel>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton isActive>Fix flaky checkout retry</SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
            <SidebarGroup>
              <SidebarGroupLabel>To review</SidebarGroupLabel>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton>Upgrade to React Router 8</SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton>Add retry budget</SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
      </SidebarProvider>
    </div>
  );
}

function ConversationDemo() {
  const lines = useHighlightedCode(
    "const attempts = 2\nawait retry(checkout, { attempts })",
    "typescript",
  );
  return (
    <div className="flex max-w-conversation flex-col gap-4">
      <Message align="end">
        <MessageContent>
          <Bubble variant="muted">
            <BubbleContent>Retry the checkout call once before failing the order.</BubbleContent>
          </Bubble>
        </MessageContent>
        <MessageFooter className="text-meta text-muted-foreground">
          Ada Lovelace · 13 Nov, 10:42
        </MessageFooter>
      </Message>
      <Trace>
        <TraceLine>
          <TraceTitle>Read checkout/retry.ts</TraceTitle>
        </TraceLine>
        <TraceLine status="running">
          <TraceTitle>Running tests</TraceTitle>
        </TraceLine>
        <TraceLine status="error">
          <TraceTitle>pnpm test failed</TraceTitle>
        </TraceLine>
      </Trace>
      <Marker>
        <MarkerContent>Checkpoint 5</MarkerContent>
      </Marker>
      <Attachment>
        <AttachmentContent>
          <AttachmentTitle className="font-mono">trace.log</AttachmentTitle>
          <AttachmentDescription>12 KB</AttachmentDescription>
        </AttachmentContent>
      </Attachment>
      <CodeBlock>
        <CodeBlockHeader>
          <CodeBlockTitle className="font-mono">retry.ts</CodeBlockTitle>
        </CodeBlockHeader>
        <CodeBlockContent>
          <CodeBlockLine>{lines[0]}</CodeBlockLine>
          <CodeBlockLine>{lines[1]}</CodeBlockLine>
        </CodeBlockContent>
      </CodeBlock>
    </div>
  );
}

export const sections: ReadonlyArray<{ id: string; title: string; Demo: () => React.ReactNode }> = [
  { id: "button", title: "Button", Demo: ButtonDemo },
  { id: "kbd", title: "Kbd", Demo: KbdDemo },
  { id: "switch", title: "Switch", Demo: SwitchDemo },
  { id: "dialog", title: "Dialog and alert dialog", Demo: DialogDemo },
  { id: "sheet", title: "Side sheet", Demo: SideSheetDemo },
  { id: "menu", title: "Menu and context menu", Demo: MenuDemo },
  { id: "toast", title: "Toast", Demo: ToastDemo },
  { id: "empty", title: "Empty state", Demo: EmptyDemo },
  { id: "form", title: "Fields and inputs", Demo: FormDemo },
  { id: "choices", title: "Toggles and tabs", Demo: ChoicesDemo },
  { id: "overlays", title: "Tooltip, popover and hover card", Demo: OverlaysDemo },
  { id: "command", title: "Command", Demo: CommandDemo },
  { id: "data", title: "Table, item, badge and progress", Demo: DataDemo },
  { id: "structure", title: "Breadcrumb, accordion, card and panels", Demo: StructureDemo },
  { id: "sidebar", title: "Sidebar", Demo: SidebarDemo },
  {
    id: "conversation",
    title: "Message, trace, marker, attachment and code block",
    Demo: ConversationDemo,
  },
  // Mend's shared components, built on the primitives above (SLNT-1092).
  ...componentSections,
];
