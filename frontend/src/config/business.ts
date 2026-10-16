/**
 * Shared Public Business Configuration for Meribaari.
 * 
 * Confirmed Business Details:
 * - Legal Business Name: RRTECH.PVT.LTD
 * - Address: DUMKA, JHARKHAND, 814151
 * - Support Email: easehealthcareapp@gmail.com
 * - Contact Number: +91 9153719933
 */

export const BUSINESS_CONFIG = {
  brandName: process.env.EXPO_PUBLIC_BRAND_NAME || "Meribaari",
  tagline: process.env.EXPO_PUBLIC_TAGLINE || "Meri baari — skip the wait.",
  websiteUrl: process.env.EXPO_PUBLIC_WEBSITE_URL || "https://www.meribaariapp.in",

  // Confirmed legal operator details
  legalBusinessName: process.env.EXPO_PUBLIC_LEGAL_BUSINESS_NAME || "RRTECH.PVT.LTD",
  address: process.env.EXPO_PUBLIC_LEGAL_ADDRESS || "DUMKA, JHARKHAND, 814151",
  supportEmail: process.env.EXPO_PUBLIC_SUPPORT_EMAIL || "easehealthcareapp@gmail.com",
  businessPhone: process.env.EXPO_PUBLIC_SUPPORT_PHONE || "+91 9153719933",

  // Formatted telephone and mailto links
  get mailtoLink(): string {
    return `mailto:${this.supportEmail}`;
  },
  get telLink(): string {
    return `tel:${this.businessPhone.replace(/[^0-9+]/g, "")}`;
  },

  // Current year for copyright statements
  copyrightYear: new Date().getFullYear(),

  // Standard verified summary for public informational displays
  aboutSummary:
    "Meribaari is a doctor appointment and live queue management platform. It helps patients book appointments and track their queue status, while helping clinics manage appointments and patient flow.",
};
