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
  brandName: "Meribaari",
  tagline: "Meri baari — skip the wait.",
  websiteUrl: "https://www.meribaariapp.in",

  // Confirmed legal operator details
  legalBusinessName: "RRTECH.PVT.LTD",
  address: "DUMKA, JHARKHAND, 814151",
  supportEmail: "easehealthcareapp@gmail.com",
  businessPhone: "+91 9153719933",

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
