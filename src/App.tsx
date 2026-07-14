import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { ToastProvider } from './components/common/Toast';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { FullPageLoader } from './components/common/FullPageLoader';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { CreatePasswordPage } from './pages/CreatePasswordPage';
import { GeneratePasswordsPage } from './pages/GeneratePasswordsPage';
import { PasswordViewPage } from './pages/PasswordViewPage';
import { QueuePage } from './pages/QueuePage';
import { BatchDetailPage } from './pages/BatchDetailPage';
import { BatchUploadPage } from './pages/BatchUploadPage';
import { SettingsPage } from './pages/SettingsPage';
import './styles/global.css';

// Protected route wrapper
function ProtectedRoute({
  children,
  requiredRole,
}: {
  children: React.ReactNode;
  requiredRole?: 'admin';
}) {
  const { user, loading } = useAuth();

  if (loading) {
    return <FullPageLoader />;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (requiredRole === 'admin' && user.role !== 'admin') {
    return <Navigate to="/admin" replace />;
  }

  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      {/* Public routes */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/p/:id" element={<PasswordViewPage />} />

      {/* Protected admin routes */}
      <Route
        path="/admin"
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/create"
        element={
          <ProtectedRoute>
            <CreatePasswordPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/generate"
        element={
          <ProtectedRoute>
            <GeneratePasswordsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/queue"
        element={
          <ProtectedRoute>
            <QueuePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/queue/batch/:batchId"
        element={
          <ProtectedRoute>
            <BatchDetailPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/batch"
        element={
          <ProtectedRoute>
            <BatchUploadPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/settings"
        element={
          <ProtectedRoute requiredRole="admin">
            <SettingsPage />
          </ProtectedRoute>
        }
      />

      {/* Default redirect */}
      <Route path="/" element={<Navigate to="/admin" replace />} />
      <Route path="*" element={<Navigate to="/admin" replace />} />
    </Routes>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <ErrorBoundary>
            <AppRoutes />
          </ErrorBoundary>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
