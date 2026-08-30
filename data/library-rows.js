/* ─────────────────────────────────────────────────────
   LIBRARY ROWS — curated structure
   Edit this file to change which books appear, which row
   they sit on, and in what order. Both library2.html and
   the compact shelf embedded in lab2.html read from here.

   Per-book fields:
     - title       (string, also looked up in the shared SPREADS catalogue)
     - year        (number, displayed in mono caps caption)
     - thumb       (cover image; used face-out and in modal fallback)
     - pdf         (URL of full PDF — opens in new tab from modal)
     - filename    (suggested download filename)
     - face        ('cover' | 'spine')
                     'cover' → shows the cover image face-out, tile sized
                               to the cover's natural aspect (no cropping)
                     'spine' → narrow rectangle with the title vertical
                               and a head/tail page-edge band
     - aspect      (number, width / height — required for face: 'cover'.
                    Measured from the actual cover image so the tile
                    matches the real book proportions.)
     - spineHue    (optional 'cream' | 'ink' | 'red' — defaults 'cream')

   Scaffold below is the default: all 19 books, four rows
   (art books split over two shelves; books about Raghava last), art books face-out,
   text books spine-only. Reorder, drop,
   or split as needed.
   ───────────────────────────────────────────────────── */
window.RKK_LIBRARY_ROWS = [
  {
    label: 'Art books',
    note: 'covers face out',
    books: [
      { title: 'The Yali Project',             year: 2026, face: 'cover', aspect: 0.7038, thumb: './images/books/art_Yali_Project.jpg',                   pdf: './books/art%20books/YALI%20PROJECT.pdf',                   filename: 'The Yali Project.pdf' },
      { title: 'too fast',                     year: 2026, face: 'cover', aspect: 1.0,    thumb: './images/books/art_too_fast.jpg',                       pdf: './books/art%20books/too%20fast.pdf',                       filename: 'too fast.pdf' },
      { title: 'PASSPORT',                     year: 2026, face: 'cover', aspect: 0.7047, thumb: './images/books/art_PASSPORT.jpg',                       pdf: './books/art%20books/PASSPORT%20book.pdf',                  filename: 'PASSPORT.pdf' },
      { title: '33M Gods',                     year: 2026, face: 'cover', aspect: 0.7047, thumb: './images/books/art_33M_Gods.jpg',                       pdf: './books/art%20books/33M%20Gods.pdf',                       filename: '33M Gods.pdf' },
      { title: 'MAYBE you KNOW ME',            year: 2024, face: 'cover', aspect: 0.7047, thumb: './images/books/art_MAYBE_you_KNOW_ME.jpg',              pdf: './books/art%20books/MAYBE%20you%20KNOW%20ME.pdf',          filename: 'MAYBE you KNOW ME.pdf' }
    ]
  },
  {
    label: 'Art books, continued',
    note: 'covers face out',
    books: [
      { title: 'On Being me!',                 year: 2024, face: 'cover', aspect: 0.7047, thumb: './images/books/art_On_Being_me!.jpg',                   pdf: './books/art%20books/On%20Being%20me!.pdf',                 filename: 'On Being me!.pdf' },
      { title: 'MASCULYNE',                    year: 2024, face: 'cover', aspect: 0.6667, thumb: './images/books/art_RKK_-_MASCULYNE.jpg',                pdf: './books/art%20books/RKK%20-%20MASCULYNE.pdf',              filename: 'MASCULYNE.pdf' },
      { title: 'Restless Frequency',           year: 2024, face: 'cover', aspect: 0.7047, thumb: './images/books/art_Restless_Frequency.jpg',             pdf: '', requestOnly: true,                                          filename: 'Restless Frequency.pdf' },
      { title: 'Superstar Rajinikanth Made Me',year: 2024, face: 'cover', aspect: 0.7047, thumb: './images/books/art_Superstar_Rajinikanth_Made_Me.jpg', pdf: './books/art%20books/Superstar%20Rajinikanth%20Made%20Me.pdf', filename: 'Superstar Rajinikanth Made Me.pdf' },
      { title: 'Chris book',                   year: 2024, face: 'cover', aspect: 0.7047, thumb: './images/books/art_Chris_book.jpg',                     pdf: './books/art%20books/Chris%20book.pdf',                     filename: 'Chris book.pdf' }
    ]
  },
  {
    label: 'Text books',
    note: 'spines only',
    books: [
      { title: 'ATTITUDES',                                year: 2024, face: 'spine', thumb: './images/books/text_ATTITUDES-Print.jpg',                                                pdf: './books/text%20only%20books/ATTITUDES-Print.pdf',                                                                  filename: 'ATTITUDES.pdf',                                  spineHue: 'cream' },
      { title: 'Artist Not Found',                         year: 2025, face: 'spine', thumb: './images/books/text_Artist_Not_Found.jpg',                                               pdf: './books/text%20only%20books/Artist%20Not%20Found,%20Raghava%20KK,%202025.pdf',                                     filename: 'Artist Not Found.pdf',                           spineHue: 'ink' },
      { title: 'Elite Sample',                             year: 2024, face: 'spine', thumb: './images/books/text_Elite-Sample_copy.pdf.jpg',                                          pdf: './books/text%20only%20books/Elite-Sample%20copy.pdf.pdf',                                                          filename: 'Elite Sample.pdf',                               spineHue: 'cream' },
      { title: "The Machine Didn't Kill Me, It Rewrote Me",year: 2025, face: 'spine', thumb: './images/books/text_The-Machine-Didnt-Kill-Me-It-Rewrote-Me-Print-2025-06-03.jpg',         pdf: './books/text%20only%20books/The-Machine-Didnt-Kill-Me-It-Rewrote-Me-Print-2025-06-03.pdf',                          filename: "The Machine Didn't Kill Me, It Rewrote Me.pdf", spineHue: 'red' },
      { title: 'The Raghava KK Studio Projects Book',      year: 2024, face: 'spine', thumb: './images/books/text_Studio_Projects_Book.jpg',                                           pdf: './books/text%20only%20books/The-Raghava-KK-Studio-Projects-Book-Print-2024-12-28.pdf',                             filename: 'The Raghava KK Studio Projects Book.pdf',        spineHue: 'cream' },
      { title: 'the duck forgot it was whole',             year: 2024, face: 'spine', thumb: './images/books/text_the_duck_forgot_it_was_whole.jpg',                                   pdf: './books/text%20only%20books/the%20duck%20forgot%20it%20was%20whole.pdf',                                           filename: 'the duck forgot it was whole.pdf',               spineHue: 'ink' }
    ]
  },
  {
    label: 'Books about Raghava',
    note: 'covers face out',
    books: [
      { title: 'About Raghava KK',             year: 2025, face: 'cover', aspect: 0.7009, thumb: './images/books/about_About_Raghava_KK.jpg',            pdf: './books/books%20about%20Raghava/About%20Raghava%20KK,%202025.pdf',        filename: 'About Raghava KK, 2025.pdf' },
      { title: 'Art Archive Book',             year: 2025, face: 'cover', aspect: 0.7038, thumb: './images/books/about_Art_Archive_Book.jpg',            pdf: './books/books%20about%20Raghava/Art%20Archive%20Book%20-%20April%202025.pdf', filename: 'Art Archive Book - April 2025.pdf' },
      { title: '64/1',                         year: 2023, face: 'cover', aspect: 0.7038, thumb: './images/books/about_64_1.jpg',                        pdf: './books/books%20about%20Raghava/641.pdf',                                 filename: '64-1.pdf' }
    ]
  }
];

// A tighter selection for the compact embed (e.g. inside lab2.html under the ▢ row).
// Defaults to one mixed row of the most recent.
window.RKK_LIBRARY_ROWS_COMPACT = [
  {
    label: 'Books on the shelf',
    note: 'pick one to read',
    books: [
      { title: 'The Yali Project',             year: 2026, face: 'cover', aspect: 0.7038, thumb: './images/books/art_Yali_Project.jpg',                   pdf: './books/art%20books/YALI%20PROJECT.pdf',                   filename: 'The Yali Project.pdf' },
      { title: 'too fast',                     year: 2026, face: 'cover', aspect: 1.0,    thumb: './images/books/art_too_fast.jpg',                       pdf: './books/art%20books/too%20fast.pdf',                       filename: 'too fast.pdf' },
      { title: 'PASSPORT',                     year: 2026, face: 'cover', aspect: 0.7047, thumb: './images/books/art_PASSPORT.jpg',                       pdf: './books/art%20books/PASSPORT%20book.pdf',                  filename: 'PASSPORT.pdf' },
      { title: '33M Gods',                     year: 2026, face: 'cover', aspect: 0.7047, thumb: './images/books/art_33M_Gods.jpg',                       pdf: './books/art%20books/33M%20Gods.pdf',                       filename: '33M Gods.pdf' },
      { title: 'Artist Not Found',             year: 2025, face: 'spine', thumb: './images/books/text_Artist_Not_Found.jpg',              pdf: './books/text%20only%20books/Artist%20Not%20Found,%20Raghava%20KK,%202025.pdf', filename: 'Artist Not Found.pdf', spineHue: 'ink' },
      { title: "The Machine Didn't Kill Me, It Rewrote Me", year: 2025, face: 'spine', thumb: './images/books/text_The-Machine-Didnt-Kill-Me-It-Rewrote-Me-Print-2025-06-03.jpg', pdf: './books/text%20only%20books/The-Machine-Didnt-Kill-Me-It-Rewrote-Me-Print-2025-06-03.pdf', filename: "The Machine Didn't Kill Me, It Rewrote Me.pdf", spineHue: 'red' }
    ]
  }
];
