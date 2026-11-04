window.__ModuleLoader__.load({
  id: '@local/dsh-bridge',
  factory: () => ({
    inject: ['uiWorkspace'],
    apply(ctx) {
      const abort = new AbortController();
      let revision = 0;
      const url = new URL('api/dsh-bridge-navigation', window.location.href);
      async function loop() {
        while (!abort.signal.aborted) {
          try {
            const request = new URL(url);
            request.searchParams.set('after', String(revision));
            const response = await fetch(request, { credentials: 'include', signal: abort.signal });
            if (!response.ok) throw new Error('Navigation bridge HTTP ' + response.status);
            const next = await response.json();
            if (next.revision > revision) {
              if (next.sessionId) {
                ctx.uiWorkspace.openSession(next.sessionId);
                const ack = await fetch(url, { method: 'POST', credentials: 'include', signal: abort.signal,
                  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: next.revision, sessionId: next.sessionId }) });
                if (!ack.ok) throw new Error('Navigation acknowledgement failed');
              }
              revision = next.revision;
            }
          } catch (error) {
            if (abort.signal.aborted) return;
            console.warn('DSH bridge navigation:', error.message);
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      }
      ctx.effect(() => { void loop(); return () => abort.abort(); }, 'dsh-bridge navigation');
    }
  })
});
