import { useCallback, useEffect, useState } from 'react';

export interface Location {
  path: string;
  params: URLSearchParams;
}

const read = (): Location => ({
  path: window.location.pathname,
  params: new URLSearchParams(window.location.search),
});

/** Path routing over the History API; `go` keeps the portal a single page between its own screens. */
export function useLocation() {
  const [location, setLocation] = useState<Location>(read);
  useEffect(() => {
    const onPop = () => setLocation(read());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const go = useCallback((to: string) => {
    window.history.pushState(null, '', to);
    setLocation(read());
  }, []);
  return { location, go };
}
