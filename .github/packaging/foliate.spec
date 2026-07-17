Name:           foliate.ai
Version:        4.0.3
Release:        1%{?dist}
Summary:        Read books in style

License:        GPLv3+
URL:            https://github.com/stonega/foliate.ai
Source0:        %{name}-%{version}.tar.gz

BuildArch:      noarch
%global debug_package %{nil}

BuildRequires:  meson
BuildRequires:  gcc
BuildRequires:  gettext
BuildRequires:  pkgconfig(gjs-1.0)
BuildRequires:  pkgconfig(gtk4)
BuildRequires:  pkgconfig(libadwaita-1)
BuildRequires:  pkgconfig(webkitgtk-6.0)
BuildRequires:  desktop-file-utils
BuildRequires:  libappstream-glib

Requires:       gjs
Requires:       gtk4
Requires:       libadwaita
Requires:       webkitgtk6.0

%description
A simple and modern eBook viewer for Linux desktops.

%prep
%autosetup

%build
%meson
%meson_build

%install
%meson_install
%find_lang io.github.stonega.foliate

%check
appstream-util validate-relax --nonet %{buildroot}%{_metainfodir}/*.xml
desktop-file-validate %{buildroot}%{_datadir}/applications/*.desktop

%files -f io.github.stonega.foliate.lang
%{_bindir}/foliate-ai
%{_datadir}/applications/*.desktop
%{_datadir}/glib-2.0/schemas/*.gschema.xml
%{_datadir}/icons/hicolor/*/apps/*.svg
%{_metainfodir}/*.xml
%{_datadir}/io.github.stonega.foliate/
%license COPYING
%doc README.md

%changelog
* Fri Jul 17 2026 stonega <stonega@users.noreply.github.com> - 4.0.3-1
- Explain selected text in a new AI chat immediately
- Add a configurable explanation language with translation support

* Thu Jul 16 2026 stonega <stonega@users.noreply.github.com> - 4.0.2-1
- Add a setting to choose Enter or Ctrl+Enter for sending AI chat messages

* Sat Jan 04 2026 stonega <stonega@users.noreply.github.com> - 4.0.0-1
- Bugs fixed

* Tue Dec 03 2024 User <user@example.com> - 3.3.0-1
- Initial package
