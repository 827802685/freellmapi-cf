import { AuthProvider } from './lib/auth';
import App from './App';
import { GalaxyBackground } from './components/GalaxyBackground';

export default function Root() {
  return (
    <AuthProvider>
      <GalaxyBackground />
      <App />
    </AuthProvider>
  );
}
