import { Navigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { LoadingBar } from "../components/LoadingBar";

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingBar />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function GuestOnly({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingBar />;
  if (user) return <Navigate to="/setup" replace />;
  return <>{children}</>;
}
