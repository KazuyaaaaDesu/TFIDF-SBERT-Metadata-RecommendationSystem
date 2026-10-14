import { lazy, Suspense } from "react";
import {
  createBrowserRouter,
  RouterProvider,
  Routes,
  Route,
  Navigate,
} from "react-router-dom";

import AuthLayout from "./layouts/AuthLayout";
import AppLayout from "./layouts/AppLayout";

import BootSplash from "./components/retro/BootSplash";
import ScanlineOverlay from "./components/retro/ScanlineOverlay";
import FeatureGate from "./components/FeatureGate";

import ForgotPassword from "./pages/auth/ForgotPassword";
import Login from "./pages/auth/Login";
import Register from "./pages/auth/Register";

import { SiteModeProvider } from "./state/siteMode";
import { isPresentationStored } from "./utils/presentation";

// Every page after sign-in is its own chunk, so the login screen does not
// download the Garden, KaTeX, the graphs and the changelog up front.
// AppLayout wraps its <Outlet /> in a Suspense boundary; /admin has its own.
const FAQ = lazy(() => import("./pages/FAQ"));
const Repository = lazy(() => import("./pages/repository/Repository"));
const Upload = lazy(() => import("./pages/repository/Upload"));
const MyLibrary = lazy(() => import("./pages/repository/MyLibrary"));
const Evaluation = lazy(() => import("./pages/evaluation/Evaluation"));
const Lab = lazy(() => import("./pages/lab/Lab"));
const Walkthrough = lazy(() => import("./pages/walkthrough/Walkthrough"));
const MathWalkthrough = lazy(() => import("./pages/walkthrough/MathWalkthrough"));
const Changelog = lazy(() => import("./pages/Changelog"));
const LibraryHome = lazy(() => import("./pages/home/LibraryHome"));
const Admin = lazy(() => import("./pages/admin/Admin"));
const Settings = lazy(() => import("./pages/Settings"));

/*
 * A data router (not <BrowserRouter>) so pages can use useBlocker, e.g. the
 * Upload page's unsaved-work prompt. One catch-all route hands every path to
 * the <Routes> tree below, so routing itself is unchanged.
 */
function AppRoutes() {
  return (
      <SiteModeProvider>
      <Routes>
        {/* Auth pages -- no top nav */}
        <Route element={<AuthLayout />}>
          <Route path="/" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
        </Route>

        {/* Library site editor -- its own chrome, admin login inside */}
        <Route
          path="/admin"
          element={
            <Suspense fallback={null}>
              <Admin />
            </Suspense>
          }
        />

        {/* Everything after sign-in shares the top nav */}
        <Route element={<AppLayout />}>
          <Route path="/home" element={<LibraryHome />} />
          <Route
            path="/recommendations"
            element={<Navigate to="/repository" replace />}
          />
          <Route
            path="/repository"
            element={
              <FeatureGate feature="repository">
                <Repository />
              </FeatureGate>
            }
          />
          <Route
            path="/upload"
            element={
              <FeatureGate feature="upload">
                <Upload />
              </FeatureGate>
            }
          />
          <Route
            path="/library"
            element={
              <FeatureGate feature="library">
                <MyLibrary />
              </FeatureGate>
            }
          />
          <Route
            path="/evaluation"
            element={
              <FeatureGate feature="arena">
                <Evaluation />
              </FeatureGate>
            }
          />
          <Route
            path="/lab"
            element={
              <FeatureGate feature="lab">
                <Lab />
              </FeatureGate>
            }
          />
          <Route
            path="/walkthrough"
            element={
              <FeatureGate feature="walkthrough">
                <Walkthrough />
              </FeatureGate>
            }
          />
          <Route
            path="/walkthrough/:page"
            element={
              <FeatureGate feature="walkthrough">
                <Walkthrough />
              </FeatureGate>
            }
          />
          <Route
            path="/walkthrough-engine"
            element={
              <FeatureGate feature="engine">
                <MathWalkthrough />
              </FeatureGate>
            }
          />
          <Route
            path="/walkthrough-engine/:page"
            element={
              <FeatureGate feature="engine">
                <MathWalkthrough />
              </FeatureGate>
            }
          />
          <Route
            path="/faq"
            element={
              <FeatureGate feature="faq">
                <FAQ />
              </FeatureGate>
            }
          />
          <Route
            path="/settings"
            element={
              <FeatureGate feature="settings">
                <Settings />
              </FeatureGate>
            }
          />
          <Route
            path="/changelog"
            element={
              <FeatureGate feature="changelog">
                <Changelog />
              </FeatureGate>
            }
          />
        </Route>

        {/* Unknown paths fall back to sign-in */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </SiteModeProvider>
  );
}

const router = createBrowserRouter([{ path: "*", element: <AppRoutes /> }]);

export default function App() {
  return (
    <>
      {!isPresentationStored() && <ScanlineOverlay />}
      {!isPresentationStored() && <BootSplash />}
      <RouterProvider router={router} />
    </>
  );
}
