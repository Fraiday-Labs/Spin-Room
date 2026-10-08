import { lazy, Suspense } from 'react';
import { Route, Switch } from 'wouter';
import { Layout } from './components/Layout';
import { Connect } from './pages/Connect';
import { DevLogin } from './pages/DevLogin';
import { Landing } from './pages/Landing';
import { NotFound } from './pages/NotFound';

// Heavier screens are split out so the landing page stays small.
const Lobby = lazy(() => import('./pages/Lobby'));
const RoomPage = lazy(() => import('./room/RoomPage'));
const RoomSettings = lazy(() => import('./pages/RoomSettings'));
const Profile = lazy(() => import('./pages/Profile'));
const Integrations = lazy(() => import('./pages/Integrations'));
const InviteLanding = lazy(() => import('./pages/InviteLanding'));
const SlackLink = lazy(() => import('./pages/SlackLink'));
const OAuthConsent = lazy(() => import('./pages/OAuthConsent'));
const Admin = lazy(() => import('./pages/Admin'));

function Loading() {
  return (
    <div className="page muted" role="status">
      Loading…
    </div>
  );
}

export function App() {
  return (
    <Switch>
      <Route path="/r/:slug">
        {(p) => (
          <Suspense fallback={<Loading />}>
            <RoomPage slug={p.slug} />
          </Suspense>
        )}
      </Route>
      <Route>
        <Layout>
          <Suspense fallback={<Loading />}>
            <Switch>
              <Route path="/" component={Landing} />
              <Route path="/connect" component={Connect} />
              <Route path="/dev-login" component={DevLogin} />
              <Route path="/lobby">
                <Lobby />
              </Route>
              <Route path="/r/:slug/settings">{(p) => <RoomSettings slug={p.slug} />}</Route>
              <Route path="/profile">
                <Profile />
              </Route>
              <Route path="/profile/:tab">{(p) => <Profile tab={p.tab} />}</Route>
              <Route path="/integrations">
                <Integrations />
              </Route>
              <Route path="/integrations/:tab">{(p) => <Integrations tab={p.tab} />}</Route>
              {/* Older links (MCP docs, emails) */}
              <Route path="/connect-agent">
                <Integrations />
              </Route>
              <Route path="/invite/:token">{(p) => <InviteLanding token={p.token} />}</Route>
              <Route path="/slack/link">
                <SlackLink />
              </Route>
              <Route path="/oauth/consent">
                <OAuthConsent />
              </Route>
              <Route path="/admin">
                <Admin />
              </Route>
              <Route component={NotFound} />
            </Switch>
          </Suspense>
        </Layout>
      </Route>
    </Switch>
  );
}
