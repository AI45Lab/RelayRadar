import { Navigate, NavLink, Route, Routes, useLocation, useParams } from "react-router-dom";
import { OverviewPage } from "./pages/OverviewPage";
import { EndpointDetailPage } from "./pages/EndpointDetailPage";
import { EndpointManagePage } from "./pages/EndpointManagePage";
import { ShieldCenterPage } from "./pages/ShieldCenterPage";
import { FingerprintCatalogPage } from "./pages/FingerprintCatalogPage";

const NAV_ITEMS = [
  { to: "/", label: "Monitor", description: "Live endpoint health", end: true, activePrefixes: ["/monitor"] },
  { to: "/routes", label: "Routes", description: "Upstream setup", activePrefixes: ["/routes"] },
  { to: "/shield", label: "Shield", description: "Policy controls" },
  { to: "/fingerprint-catalog", label: "Fingerprint", description: "Baseline research" }
];

function isNavItemActive(item: (typeof NAV_ITEMS)[number], pathname: string): boolean {
  if (pathname === item.to) {
    return true;
  }
  return item.activePrefixes?.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)) ?? false;
}

function LegacyEndpointDetailRedirect() {
  const { endpointId = "" } = useParams();
  return <Navigate to={`/monitor/endpoints/${encodeURIComponent(endpointId)}`} replace />;
}

function LegacyOperationsDetailRedirect() {
  const { endpointId = "" } = useParams();
  return <Navigate to={`/monitor/endpoints/${encodeURIComponent(endpointId)}`} replace />;
}

export function App() {
  const location = useLocation();
  const activeItem = NAV_ITEMS.find((item) => isNavItemActive(item, location.pathname)) ?? NAV_ITEMS[0];

  return (
    <div className="console-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <img src="/assets/logo2.png" alt="RelayRadar" className="brand-wordmark" />
          <h1 className="sr-only">RelayRadar Console</h1>
          <span className="brand-subtitle">Control Plane</span>
        </div>

        <nav className="side-nav" aria-label="Primary navigation">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={() => (isNavItemActive(item, location.pathname) ? "active" : "")}
            >
              <span className="nav-marker" aria-hidden="true" />
              <span>
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <span>Environment</span>
          <strong>Local Relay</strong>
        </div>
      </aside>

      <div className="workspace">
        <header className="workspace-bar">
          <div>
            <span className="workspace-kicker">{activeItem?.description}</span>
            <strong>{activeItem?.label}</strong>
          </div>
          <div className="workspace-status">
            <span className="live-dot" aria-hidden="true" />
            Connected to proxy
          </div>
        </header>

        <main className="main">
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/routes" element={<EndpointManagePage />} />
            <Route path="/configure" element={<Navigate to="/routes" replace />} />
            <Route path="/monitor/endpoints/:endpointId" element={<EndpointDetailPage />} />
            <Route path="/operations/endpoints/:endpointId" element={<LegacyOperationsDetailRedirect />} />
            <Route path="/endpoints" element={<Navigate to="/routes" replace />} />
            <Route path="/endpoints/:endpointId" element={<LegacyEndpointDetailRedirect />} />
            <Route path="/shield" element={<ShieldCenterPage />} />
            <Route path="/fingerprint-catalog" element={<FingerprintCatalogPage />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
