import { useCallback, useEffect, useState } from 'react';

/** The few routes there are need no router library: path only, History API, no record identifiers anywhere. */
export function useLocation() {
  const [loc, setLoc] = useState(() => ({
    path: window.location.pathname,
    search: window.location.search,
  }));
  useEffect(() => {
    const on = () => setLoc({ path: window.location.pathname, search: window.location.search });
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const navigate = useCallback((path: string, replace = false) => {
    if (replace) window.history.replaceState(null, '', path);
    else window.history.pushState(null, '', path);
    setLoc({ path: window.location.pathname, search: window.location.search });
  }, []);
  return { ...loc, navigate };
}
