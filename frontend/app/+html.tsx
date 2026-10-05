// @ts-nocheck
import { ScrollViewStyleReset } from "expo-router/html";
import type { PropsWithChildren } from "react";

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en" style={{ height: "100%" }}>
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
        <meta name="google-site-verification" content="odBixVw-npeF1pKbiKtQ8c85qhvGX0UPzNCRC_oY82M" />
        <meta name="theme-color" content="#0369A1" />
        <meta name="description" content="MeriBaari — Book doctor appointments, view live token numbers, and track rolling estimated waiting times in real-time." />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="MeriBaari" />
        <link rel="canonical" href="https://www.meribaariapp.in" />
        <link rel="manifest" href="/manifest.json" />
        <link rel="apple-touch-icon" href="/assets/images/icon.png" />
        <title>MeriBaari — Live Clinic Tokens & Doctor Appointment Waiting Times</title>

        {/* Open Graph Meta Tags */}
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="MeriBaari" />
        <meta property="og:title" content="MeriBaari — Live Clinic Tokens & Doctor Appointment Waiting Times" />
        <meta property="og:description" content="Book doctor appointments, check live token status, and view real-time rolling estimated waiting times." />
        <meta property="og:url" content="https://www.meribaariapp.in" />
        <meta property="og:image" content="https://www.meribaariapp.in/assets/images/icon.png" />

        {/* Twitter Card Meta Tags */}
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content="MeriBaari — Live Clinic Tokens & Doctor Appointment Waiting Times" />
        <meta name="twitter:description" content="Book doctor appointments, check live token status, and view real-time rolling estimated waiting times." />
        <meta name="twitter:image" content="https://www.meribaariapp.in/assets/images/icon.png" />

        {/* Structured Data: Schema.org */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "SoftwareApplication",
              "name": "MeriBaari",
              "applicationCategory": "HealthApplication",
              "operatingSystem": "Web, Android, iOS",
              "url": "https://www.meribaariapp.in",
              "description": "Smart doctor appointment booking and real-time clinic queue management system.",
              "offers": {
                "@type": "Offer",
                "price": "0",
                "priceCurrency": "INR"
              }
            }),
          }}
        />

        {/* Dynamic Private Route Protection: Injects noindex on private dashboards */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                var privatePaths = ['/patient', '/appointment', '/doctor', '/receptionist', '/owner', '/admin', '/otp', '/hospital-auth'];
                var path = window.location.pathname;
                var isPrivate = privatePaths.some(function(p) { return path.indexOf(p) === 0; });
                if (isPrivate) {
                  var meta = document.createElement('meta');
                  meta.name = 'robots';
                  meta.content = 'noindex, nofollow, noarchive';
                  document.head.appendChild(meta);
                }
              })();
            `,
          }}
        />

        {/*
          Disable body scrolling on web so ScrollView works correctly.
        */}
        <ScrollViewStyleReset />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              body > div:first-child { position: fixed !important; top: 0; left: 0; right: 0; bottom: 0; }
              [role="tablist"] [role="tab"] * { overflow: visible !important; }
              [role="heading"], [role="heading"] * { overflow: visible !important; }
            `,
          }}
        />
      </head>
      <body
        style={{
          margin: 0,
          height: "100%",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {children}
      </body>
    </html>
  );
}
