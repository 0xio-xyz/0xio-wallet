import React, { createContext, useContext, useEffect, useState } from 'react';

type ThemeValue = 'dim' | 'light' | 'octra';

interface ThemeContextValue {
  theme: ThemeValue;
  toggleTheme: () => void;
  setTheme: (theme: ThemeValue) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export const ThemeProvider = ({ children }: { children: React.ReactNode }) => {
  const [theme, setTheme] = useState<ThemeValue>('dim');

  useEffect(() => {
    chrome.storage.local.get(['app_theme'], (result) => {
      if (result.app_theme) {
        setTheme(result.app_theme);
      }
    });
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dim') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', theme);
    }

    chrome.storage.local.set({ app_theme: theme });
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dim' ? 'light' : prev === 'light' ? 'octra' : 'dim'));
  };

  const setSpecificTheme = (newTheme: ThemeValue) => {
    if (newTheme === 'light' || newTheme === 'dim' || newTheme === 'octra') {
      setTheme(newTheme);
    }
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme: setSpecificTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};
