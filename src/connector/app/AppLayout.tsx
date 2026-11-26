import { createContext, useContext, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

export type ConnectorLanguage = "en" | "zh";
export const ConnectorLanguageContext = createContext<ConnectorLanguage>("en");
export function useConnectorLanguage() {
  return useContext(ConnectorLanguageContext);
}

type Asset = "MIP" | "ENI" | "MIE";

export function ConnectorRouteSync({
  externalRoute,
  onRouteChange,
}: {
  externalRoute?: { path: string; seq: number };
  onRouteChange?: (path: string) => void;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  useEffect(() => {
    onRouteChange?.(pathname);
  }, [pathname, onRouteChange]);

  useEffect(() => {
    if (externalRoute && externalRoute.seq > 0 && externalRoute.path !== pathname) {
      navigate(externalRoute.path);
    }
  }, [externalRoute]);

  return null;
}

export function AppHeader(_props: { asset?: Asset; onAssetChange?: (asset: Asset) => void }) {
  return null;
}

export function AppFooter(_props: { onVersionClick?: () => void }) {
  return null;
}
