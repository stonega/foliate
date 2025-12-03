Name:           foliate
Version:        3.3.0
Release:        1%{?dist}
Summary:        Read books in style

License:        GPLv3+
URL:            https://github.com/johnfactotum/foliate
Source0:        %{name}-%{version}.tar.gz

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
%find_lang com.github.johnfactotum.Foliate

%check
appstream-util validate-relax --nonet %{buildroot}%{_metainfodir}/*.xml
desktop-file-validate %{buildroot}%{_datadir}/applications/*.desktop

%files -f com.github.johnfactotum.Foliate.lang
%{_bindir}/foliate
%{_datadir}/applications/*.desktop
%{_datadir}/glib-2.0/schemas/*.gschema.xml
%{_datadir}/icons/hicolor/*/apps/*.svg
%{_metainfodir}/*.xml
%{_datadir}/com.github.johnfactotum.Foliate/
%license COPYING
%doc README.md

%changelog
* Tue Dec 03 2024 User <user@example.com> - 3.3.0-1
- Initial package
