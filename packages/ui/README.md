# @mend/ui

Mend's UI kit: shadcn's `base-nova` style on Base UI, themed to Sheet, the look on the Doop canvas
"Mend" (`eOZgbKdtRc`). The new web app (`apps/web`) builds on it. Desktop, marketing, mobile, the
API and the old web app stay on `@mend/ui-old`.

## Using it

Import the faces and the theme once, at the app's root stylesheet:

```css
@import "@mend/ui/styles/fonts.css";
@import "@mend/ui/styles/globals.css";
@source "../node_modules/@mend/ui/src";
```

Dark is the `dark` class on `<html>`. Components come from `@mend/ui/components/ui/<name>`; class
names merge with `cn` from `@mend/ui/lib/utils`.

Every colour, radius, shadow and off-scale type size is a token in `src/styles/globals.css`. Use its
names (`bg-canvas`, `text-meta`, `rounded-chip`, `shadow-pop`, `w-sidebar`); never write a raw
value.

## Adding a component

```sh
cd packages/ui
pnpm dlx shadcn@latest add <name>
```

Then, in each new file:

- import `cn` from `@mend/ui/lib/utils`, not from `"cn"`. The kit's `cn` knows the names
  `globals.css` adds to Tailwind's scales; the plain one reads `text-meta` as a colour and drops the
  colour class beside it. A new name in `globals.css` goes into `lib/utils.ts` too.
- remove any `"use client"` line.
- move each new dependency into the root `pnpm-workspace.yaml` catalog and reference it as
  `catalog:`.

## The gallery

```sh
pnpm --filter @mend/ui gallery
```

A Vite page on port 5199 showing every component in each variant and size, with light and dark and a
390px mode. The URL picks the starting view, for screenshots:
`?theme=dark&width=390&section=menu&open=menu`. It is a dev page only; no app or image includes it.
