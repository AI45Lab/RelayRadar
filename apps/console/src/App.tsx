import { NavLink, Route, Routes } from "react-router-dom";
import { OverviewPage } from "./pages/OverviewPage";
import { EndpointDetailPage } from "./pages/EndpointDetailPage";
import { EndpointManagePage } from "./pages/EndpointManagePage";
import { ShieldCenterPage } from "./pages/ShieldCenterPage";
import { FingerprintCatalogPage } from "./pages/FingerprintCatalogPage";

export function App() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <img src="/assets/logo2.png" alt="RelayRadar" className="brand-wordmark" />
          <h1 className="sr-only">RelayRadar Console</h1>
        </div>
        <nav className="topnav">
          <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : "")}>Overview</NavLink>
          <NavLink to="/endpoints" className={({ isActive }) => (isActive ? "active" : "")}>Endpoints</NavLink>
          <NavLink to="/shield" className={({ isActive }) => (isActive ? "active" : "")}>Shield Center</NavLink>
          <NavLink to="/fingerprint-catalog" className={({ isActive }) => (isActive ? "active" : "")}>Fingerprint Lab</NavLink>
        </nav>
      </header>

      <main className="main">
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/endpoints" element={<EndpointManagePage />} />
          <Route path="/endpoints/:endpointId" element={<EndpointDetailPage />} />
          <Route path="/shield" element={<ShieldCenterPage />} />
          <Route path="/fingerprint-catalog" element={<FingerprintCatalogPage />} />
        </Routes>
      </main>
    </div>
  );
}
