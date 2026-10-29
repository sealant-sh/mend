import { useEffect, type ReactNode } from "react";

type Href = string | { readonly pathname: string; readonly params?: Record<string, string> };

export const route: { params: Record<string, string> } = { params: {} };

export const navigation = {
  navigatorMounted: false,
  title: "",
  replaced: [] as Array<Href>,
  pushed: [] as Array<{ readonly href: Href; readonly navigatorMounted: boolean }>,
};

const router = {
  push: (href: Href) => {
    navigation.pushed.push({ href, navigatorMounted: navigation.navigatorMounted });
  },
  replace: (href: Href) => {
    navigation.replaced.push(href);
  },
  back: () => undefined,
  canGoBack: () => true,
};

const Stack = Object.assign(
  ({ children: _screens }: { readonly children?: ReactNode }) => {
    useEffect(() => {
      navigation.navigatorMounted = true;
      return () => {
        navigation.navigatorMounted = false;
      };
    }, []);
    return null;
  },
  {
    Screen: ({ options }: { readonly options?: { readonly title?: string } }) => {
      navigation.title = options?.title ?? "";
      return null;
    },
  },
);

const theme = { dark: false, colors: {}, fonts: {} };

export const fakeExpoRouter = {
  Stack,
  ThemeProvider: ({ children }: { readonly children: ReactNode }) => children,
  DarkTheme: theme,
  DefaultTheme: theme,
  useLocalSearchParams: () => route.params,
  useRouter: () => router,
};
