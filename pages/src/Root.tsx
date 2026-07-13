import { AuthProvider } from './lib/auth';
import App from './App';

export default function Root() {
  return (
    <AuthProvider>
      <App />
    </AuthProvider>
  );
}
