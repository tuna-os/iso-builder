// Package winvol maps Windows volumes to physical disk numbers and locks and
// dismounts every volume of a disk before a raw write (the Rufus and
// Raspberry Pi Imager approach). Windows only; empty elsewhere.
package winvol
